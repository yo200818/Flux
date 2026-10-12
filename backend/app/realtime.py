from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from collections.abc import Awaitable
from pathlib import Path
from collections.abc import Callable
from typing import Literal
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, ValidationError

from app.security import authenticate_token

logger = logging.getLogger(__name__)
PROTOCOL_VERSION = 1
MAX_WEBSOCKET_MESSAGE_BYTES = 4096


class ConfigurationUploadError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class ClientMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_version: Literal[1]
    type: Literal["client.ping"]


class ServerEvent(BaseModel):
    protocol_version: Literal[1] = PROTOCOL_VERSION
    event_id: str
    type: Literal[
        "connection.ready",
        "config.updated",
        "server.pong",
        "protocol.error",
    ]
    revision: int | None = None
    payload: dict[str, str | int | bool | None]


def create_server_event(
    event_type: Literal[
        "connection.ready",
        "config.updated",
        "server.pong",
        "protocol.error",
    ],
    *,
    revision: int | None = None,
    payload: dict[str, str | int | bool | None] | None = None,
) -> dict[str, object]:
    return ServerEvent(
        event_id=str(uuid4()),
        type=event_type,
        revision=revision,
        payload=payload or {},
    ).model_dump(mode="json", exclude_none=True)


class WebSocketConnectionManager:
    """Track local development clients and broadcast revision notifications."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._credentials: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    async def connect(
        self,
        websocket: WebSocket,
        get_revision: Callable[[], int],
        credential: str,
        subprotocol: str = "pocketdeck.v1",
    ) -> None:
        await websocket.accept(subprotocol=subprotocol)
        async with self._lock:
            self._connections.add(websocket)
            self._credentials[websocket] = credential
            try:
                await websocket.send_json(
                    create_server_event(
                        "connection.ready",
                        revision=get_revision(),
                        payload={"message": "PocketDeck event stream ready."},
                    )
                )
            except Exception:
                self._connections.discard(websocket)
                self._credentials.pop(websocket, None)
                raise

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)
            self._credentials.pop(websocket, None)

    async def send_pong(self, websocket: WebSocket, revision: int) -> None:
        await websocket.send_json(
            create_server_event("server.pong", revision=revision)
        )

    async def send_protocol_error(
        self, websocket: WebSocket, message: str
    ) -> None:
        await websocket.send_json(
            create_server_event(
                "protocol.error",
                payload={"message": message},
            )
        )

    async def broadcast_configuration_updated(self, revision: int) -> None:
        event = create_server_event("config.updated", revision=revision)
        async with self._lock:
            disconnected: list[WebSocket] = []
            for websocket in self._connections:
                credential = self._credentials.get(websocket)
                if (
                    credential is None
                    or authenticate_token(websocket.app, credential) is None
                ):
                    try:
                        await websocket.close(code=1008)
                    except (WebSocketDisconnect, RuntimeError):
                        pass
                    disconnected.append(websocket)
                    continue
                try:
                    await websocket.send_json(event)
                except (WebSocketDisconnect, RuntimeError):
                    disconnected.append(websocket)
                except Exception:
                    logger.exception(
                        "Failed to send configuration revision %s to a WebSocket client.",
                        revision,
                    )
                    disconnected.append(websocket)
            self._connections.difference_update(disconnected)


class PairingWebSocketManager:
    """Deliver one-time pairing outcomes only on the claimant's TLS WebSocket."""

    def __init__(self, action_store_path: Path) -> None:
        self._connections: dict[str, tuple[WebSocket, asyncio.AbstractEventLoop]] = {}
        self._sessions: dict[
            WebSocket, tuple[str, asyncio.AbstractEventLoop]
        ] = {}
        self._device_sessions: dict[str, set[WebSocket]] = {}
        self._configuration_uploads: dict[
            tuple[str, str],
            tuple[asyncio.Future[dict[str, object]], asyncio.AbstractEventLoop, WebSocket],
        ] = {}
        self._lock = threading.RLock()
        action_store_path.parent.mkdir(parents=True, exist_ok=True)
        self._action_store = sqlite3.connect(
            action_store_path,
            timeout=10,
            check_same_thread=False,
        )
        self._action_store.execute(
            """
            CREATE TABLE IF NOT EXISTS action_results (
                device_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, message_id)
            )
            """
        )
        self._action_store.commit()

    async def register(self, request_id: str, websocket: WebSocket) -> None:
        with self._lock:
            self._connections[request_id] = (websocket, asyncio.get_running_loop())

    async def forget(self, request_id: str, websocket: WebSocket) -> None:
        with self._lock:
            current = self._connections.get(request_id)
            if current is not None and current[0] is websocket:
                self._connections.pop(request_id, None)

    async def register_session(self, websocket: WebSocket, device_id: str) -> None:
        with self._lock:
            self._sessions[websocket] = (device_id, asyncio.get_running_loop())
            self._device_sessions.setdefault(device_id, set()).add(websocket)

    async def forget_session(self, websocket: WebSocket) -> None:
        with self._lock:
            session = self._sessions.pop(websocket, None)
            if session is not None:
                device_id = session[0]
                sessions = self._device_sessions.get(device_id)
                if sessions is not None:
                    sessions.discard(websocket)
                    if not sessions:
                        self._device_sessions.pop(device_id, None)

    async def disconnect_device(self, device_id: str) -> None:
        with self._lock:
            sessions = [
                (websocket, self._sessions[websocket][1])
                for websocket in self._device_sessions.pop(device_id, set())
                if websocket in self._sessions
            ]
            for websocket, _ in sessions:
                self._sessions.pop(websocket, None)
        for websocket, loop in sessions:
            try:
                await self._run_on_loop(
                    loop,
                    websocket.close(code=1008, reason="Device credential revoked."),
                )
            except (RuntimeError, WebSocketDisconnect):
                logger.info("Revoked device WebSocket was already disconnected.")

    def get_action_result(
        self, device_id: str, message_id: str
    ) -> dict[str, object] | None:
        with self._lock:
            row = self._action_store.execute(
                "SELECT result_json FROM action_results "
                "WHERE device_id = ? AND message_id = ?",
                (device_id, message_id),
            ).fetchone()
            if row is None:
                return None
            result = json.loads(row[0])
            if not isinstance(result, dict):
                raise RuntimeError("A stored action idempotency result is invalid.")
            return result

    def get_session_device(self, websocket: WebSocket) -> str | None:
        with self._lock:
            session = self._sessions.get(websocket)
            return session[0] if session is not None else None

    async def upload_configuration(
        self,
        device_id: str,
        payload: dict[str, object],
        *,
        timeout_seconds: float = 30,
    ) -> dict[str, object]:
        with self._lock:
            sessions = list(self._device_sessions.get(device_id, ()))
            if not sessions:
                raise ConfigurationUploadError(
                    "The selected Android device is not connected.",
                    409,
                )
            if len(sessions) != 1:
                raise ConfigurationUploadError(
                    "Disconnect duplicate Android sessions before uploading.",
                    409,
                )
            websocket = sessions[0]
            session = self._sessions.get(websocket)
            if session is None or session[0] != device_id:
                raise ConfigurationUploadError(
                    "The selected Android session is no longer active.",
                    409,
                )
            websocket_loop = session[1]

        request_loop = asyncio.get_running_loop()
        message_id = str(uuid4())
        result_future: asyncio.Future[dict[str, object]] = request_loop.create_future()
        upload_key = (device_id, message_id)
        with self._lock:
            self._configuration_uploads[upload_key] = (
                result_future,
                request_loop,
                websocket,
            )
        try:
            await self._run_on_loop(
                websocket_loop,
                websocket.send_json(
                    {
                        "protocol_version": 2,
                        "message_id": message_id,
                        "type": "configuration.upload",
                        "payload": payload,
                    }
                ),
            )
            return await asyncio.wait_for(result_future, timeout=timeout_seconds)
        except TimeoutError as error:
            raise ConfigurationUploadError(
                "The Android device did not confirm saving the configuration.",
                504,
            ) from error
        finally:
            with self._lock:
                self._configuration_uploads.pop(upload_key, None)

    def complete_configuration_upload(
        self,
        websocket: WebSocket,
        device_id: str,
        message_id: str,
        result: dict[str, object],
    ) -> bool:
        with self._lock:
            pending = self._configuration_uploads.get((device_id, message_id))
        if pending is None or pending[2] is not websocket:
            return False
        future, loop, _ = pending

        def complete() -> None:
            if not future.done():
                future.set_result(result)

        loop.call_soon_threadsafe(complete)
        return True

    def reserve_action(
        self, device_id: str, message_id: str, action_id: str
    ) -> bool:
        with self._lock:
            result = {
                "action_id": action_id,
                "outcome": "unknown",
                "code": "action_in_progress",
                "message": "The original action request is still processing.",
            }
            cursor = self._action_store.execute(
                "INSERT OR IGNORE INTO action_results "
                "(device_id, message_id, result_json) VALUES (?, ?, ?)",
                (device_id, message_id, json.dumps(result)),
            )
            self._action_store.commit()
            return cursor.rowcount == 1

    def complete_action(
        self,
        device_id: str,
        message_id: str,
        result: dict[str, object],
    ) -> None:
        with self._lock:
            self._action_store.execute(
                "UPDATE action_results SET result_json = ?, "
                "created_at = CURRENT_TIMESTAMP WHERE device_id = ? AND message_id = ?",
                (json.dumps(result), device_id, message_id),
            )
            self._action_store.commit()

    @staticmethod
    async def _run_on_loop(
        loop: asyncio.AbstractEventLoop,
        operation: Awaitable[object],
    ) -> object:
        if loop is asyncio.get_running_loop():
            return await operation
        future = asyncio.run_coroutine_threadsafe(operation, loop)
        return await asyncio.wrap_future(future)

    async def deliver_approval(
        self, request_id: str, device_id: str, credential: str
    ) -> bool:
        return await self._deliver(
            request_id,
            "pairing.approved",
            {
                "request_id": request_id,
                "device_id": device_id,
                "credential": credential,
                "credential_expires_at": None,
            },
        )

    async def deliver_rejection(self, request_id: str) -> bool:
        return await self._deliver(
            request_id,
            "pairing.status.result",
            {"request_id": request_id, "status": "rejected"},
        )

    async def _deliver(
        self,
        request_id: str,
        message_type: str,
        payload: dict[str, object],
    ) -> bool:
        with self._lock:
            connection = self._connections.pop(request_id, None)
        if connection is None:
            return False
        websocket, loop = connection
        try:
            await self._run_on_loop(
                loop,
                websocket.send_json(
                    {
                        "protocol_version": 2,
                        "message_id": str(uuid4()),
                        "type": message_type,
                        "payload": payload,
                    }
                ),
            )
            return True
        except (WebSocketDisconnect, RuntimeError):
            logger.info("Pairing client disconnected before its one-time result was delivered.")
            return True


async def handle_websocket_messages(
    websocket: WebSocket,
    manager: WebSocketConnectionManager,
    get_revision: Callable[[], int],
    credential: str,
    subprotocol: str = "pocketdeck.v1",
) -> None:
    await manager.connect(websocket, get_revision, credential, subprotocol)
    try:
        while True:
            try:
                raw_message = await websocket.receive_text()
                if len(raw_message.encode("utf-8")) > MAX_WEBSOCKET_MESSAGE_BYTES:
                    await manager.send_protocol_error(
                        websocket,
                        f"Messages must be at most {MAX_WEBSOCKET_MESSAGE_BYTES} bytes.",
                    )
                    await websocket.close(code=1009)
                    return
                decoded_message = json.loads(raw_message)
            except (ValueError, RuntimeError):
                await manager.send_protocol_error(
                    websocket, "Expected a valid version 1 JSON message."
                )
                await websocket.close(code=1003)
                return
            if authenticate_token(websocket.app, credential) is None:
                await websocket.close(code=1008)
                return

            try:
                message = ClientMessage.model_validate(decoded_message)
            except ValidationError:
                await manager.send_protocol_error(
                    websocket,
                    "Unsupported message. Only client.ping is accepted.",
                )
                await websocket.close(code=1003)
                return

            if message.type == "client.ping":
                await manager.send_pong(websocket, get_revision())
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
