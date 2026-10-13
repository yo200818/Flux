from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import time
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.config.migration import ConfigurationMigrationError, migrate_v1_to_v2
from app.config.models import configuration_to_document
from app.actions.execution import ActionExecutionError, execute_configured_action
from app.devices import PAIRING_CODE_DIGITS, DeviceInput, PairingError
from app.security import authenticate_token
logger = logging.getLogger(__name__)
router = APIRouter(tags=["realtime-v2"])
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_CONTROL_MESSAGE_BYTES = 16 * 1024


def _envelope(raw: str) -> tuple[dict[str, object], str, str, dict[str, object]]:
    if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError("message_too_large: Message exceeds the protocol size limit.")
    message = json.loads(raw)
    if (
        not isinstance(message, dict)
        or set(message) - {"protocol_version", "message_id", "in_reply_to", "type", "payload"}
        or message.get("protocol_version") != 2
        or type(message.get("protocol_version")) is not int
        or not isinstance(message.get("type"), str)
        or not isinstance(message.get("payload"), dict)
    ):
        raise ValueError("invalid_message: Invalid Protocol v2 envelope.")
    try:
        message_id = str(UUID(message["message_id"]))
        in_reply_to = (
            str(UUID(message["in_reply_to"]))
            if "in_reply_to" in message
            else None
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid_message: Message IDs must be UUIDs.") from error
    return message, message_id, in_reply_to, message["payload"]


async def _send(
    websocket: WebSocket,
    message_type: str,
    payload: dict[str, object],
    *,
    in_reply_to: str | None = None,
) -> None:
    message: dict[str, object] = {
        "protocol_version": 2,
        "message_id": str(uuid4()),
        "type": message_type,
        "payload": payload,
    }
    if in_reply_to is not None:
        message["in_reply_to"] = in_reply_to
    encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    limit = MAX_MESSAGE_BYTES if message_type in {"config.snapshot", "config.delta"} else MAX_CONTROL_MESSAGE_BYTES
    if len(encoded) > limit:
        raise ValueError("message_too_large: Message exceeds the protocol size limit.")
    await websocket.send_text(encoded.decode("utf-8"))


async def _error(
    websocket: WebSocket,
    code: str,
    message: str,
    *,
    in_reply_to: str | None = None,
) -> None:
    await _send(
        websocket,
        "protocol.error",
        {"code": code, "message": message[:512], "retryable": False},
        in_reply_to=in_reply_to,
    )


def _pairing_token(websocket: WebSocket) -> str | None:
    authorization = websocket.headers.get("authorization", "")
    scheme, separator, credential = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not credential:
        return None
    if credential != credential.strip() or " " in credential:
        return None
    return credential


def _configuration_snapshot(websocket: WebSocket) -> tuple[int, dict[str, object]]:
    state = websocket.app.state
    current = state.configuration_manager.get_snapshot()
    document = migrate_v1_to_v2(
        configuration_to_document(current.configuration),
        state.windows_identity.migration_namespace,
    )
    return current.revision, document


async def _execute_action(
    websocket: WebSocket,
    message_id: str,
    payload: dict[str, object],
) -> dict[str, object]:
    state = websocket.app.state
    device_id = state.pairing_websocket_manager.get_session_device(websocket)
    if device_id is None:
        raise ValueError("The authenticated device session is no longer active.")
    previous = state.pairing_websocket_manager.get_action_result(device_id, message_id)
    if previous is not None:
        return previous

    action_data = payload.get("action")
    action_id = (
        action_data.get("id")
        if isinstance(action_data, dict) and isinstance(action_data.get("id"), str)
        else "unknown"
    )
    result: dict[str, object] = {
        "action_id": action_id,
        "outcome": "failed",
        "code": "invalid_action",
        "message": "The action request is invalid.",
    }
    if not state.pairing_websocket_manager.reserve_action(
        device_id,
        message_id,
        action_id,
    ):
        return state.pairing_websocket_manager.get_action_result(device_id, message_id) or result
    try:
        if set(payload) != {"button_id", "config_epoch", "config_revision", "action"}:
            raise ValueError("The action request contains unsupported fields.")
        if (
            payload["config_epoch"] != state.windows_identity.config_epoch
            or type(payload["config_revision"]) is not int
            or payload["config_revision"] != state.configuration_manager.get_snapshot().revision
        ):
            result = {
                "action_id": action_id,
                "outcome": "failed",
                "code": "revision_conflict",
                "message": "The Windows configuration changed. Synchronize before retrying.",
            }
        else:
            current = state.configuration_manager.get_snapshot()
            legacy_configuration = current.configuration
            v2_document = migrate_v1_to_v2(
                configuration_to_document(legacy_configuration),
                state.windows_identity.migration_namespace,
            )
            if (
                not isinstance(payload["button_id"], str)
                or not isinstance(action_data, dict)
                or action_data.get("target") != "windows_host"
                or action_data not in v2_document["actions"]
            ):
                raise ValueError("The action is not a current Windows-hosted action.")
            assigned = any(
                button["id"] == payload["button_id"]
                and button.get("action_id") == action_id
                for profile in v2_document["profiles"]
                for page in profile["pages"]
                for button in page["buttons"]
            )
            if not assigned:
                raise ValueError("The action is not assigned to the requested button.")
            try:
                execution = execute_configured_action(
                    legacy_configuration,
                    action_id,
                )
            except ActionExecutionError as error:
                result = {
                    "action_id": action_id,
                    "outcome": "failed",
                    "code": error.code,
                    "message": str(error)[:512],
                }
            else:
                result = {
                    "action_id": action_id,
                    "outcome": "succeeded" if execution.success else "failed",
                    "message": execution.message[:512],
                }
                if not execution.success:
                    result["code"] = "action_failed"
    except (ConfigurationMigrationError, ValueError, TypeError, KeyError) as error:
        result = {
            "action_id": action_id,
            "outcome": "failed",
            "code": "invalid_action",
            "message": str(error)[:512],
        }
    state.pairing_websocket_manager.complete_action(device_id, message_id, result)
    return result


async def _pair(
    websocket: WebSocket,
    pairing_code: str,
    device_name: str,
    transport: str = "wifi",
) -> None:
    try:
        device_input = DeviceInput(name=device_name, client_type="android")
        pairing_manager = websocket.app.state.pairing_manager
        client_key = websocket.client.host if websocket.client else "unknown"
        claim = (
            pairing_manager.claim_usb(device_input, client_key=client_key)
            if transport == "usb"
            else pairing_manager.claim(
                pairing_code,
                device_input,
                client_key=client_key,
            )
        )
    except (PairingError, ValidationError, ValueError) as error:
        logger.info(
            "Protocol v2 pairing claim rejected code=%s connection=%s.",
            getattr(error, "code", "invalid_pairing_claim"),
            getattr(websocket, "scope", {}).get("client"),
        )
        await _error(websocket, "pairing_code_invalid", str(error))
        await websocket.close(code=1008)
        return

    request_id = claim.request_id
    logger.warning(
        "Protocol v2 pairing request registered request_id=%s device_id=%s.",
        request_id,
        claim.device_id,
    )
    await websocket.app.state.pairing_websocket_manager.register(request_id, websocket)
    await _send(
        websocket,
        "pairing.pending",
        {
            "request_id": request_id,
            "device_id": claim.device_id,
            "status": "pending",
            "expires_at": claim.expires_at.isoformat(),
        },
    )
    expires_at = claim.expires_at
    try:
        while True:
            remaining_seconds = max(
                0.0,
                (expires_at - datetime.now(timezone.utc)).total_seconds(),
            )
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=remaining_seconds,
                )
            except TimeoutError:
                await _send(
                    websocket,
                    "pairing.status.result",
                    {"request_id": request_id, "status": "expired"},
                )
                await websocket.close(code=1008)
                return
            if len(raw.encode("utf-8")) > MAX_CONTROL_MESSAGE_BYTES:
                await _error(websocket, "message_too_large", "Control messages exceed 16 KiB.")
                await websocket.close(code=1009)
                return
            try:
                message, message_id, _, payload = _envelope(raw)
            except (json.JSONDecodeError, ValueError) as error:
                await _error(websocket, "invalid_message", str(error))
                await websocket.close(code=1003)
                return
            if message["type"] != "pairing.status" or set(payload) != {"request_id"}:
                await _error(
                    websocket,
                    "invalid_message",
                    "Only pairing.status is accepted while pairing is pending.",
                    in_reply_to=message_id,
                )
                await websocket.close(code=1008)
                return
            if payload["request_id"] != request_id:
                await _error(
                    websocket,
                    "unauthorized",
                    "The pairing request does not belong to this connection.",
                    in_reply_to=message_id,
                )
                await websocket.close(code=1008)
                return
            await _send(
                websocket,
                "pairing.status.result",
                {"request_id": request_id, "status": "pending"},
                in_reply_to=message_id,
            )
    except WebSocketDisconnect:
        pass
    finally:
        await websocket.app.state.pairing_websocket_manager.forget(
            request_id, websocket
        )


@router.websocket("/ws/v2")
async def websocket_v2(websocket: WebSocket) -> None:
    connection_id = str(uuid4())
    if websocket.url.scheme != "wss":
        logger.warning("Protocol v2 rejected non-TLS connection id=%s.", connection_id)
        await websocket.close(code=1008)
        return
    if websocket.headers.get("sec-websocket-protocol") != "pocketdeck.v2":
        logger.warning(
            "Protocol v2 rejected subprotocol connection id=%s.",
            connection_id,
        )
        await websocket.close(code=1002)
        return

    token = _pairing_token(websocket)
    authenticated = (
        authenticate_token(websocket.app, token) if token is not None else None
    )
    if token is not None and (
        authenticated is None or authenticated.device is None
    ):
        rejection_reason = (
            websocket.app.state.device_registry.credential_rejection_reason(token)
        )
        logger.warning(
            "Protocol v2 rejected device credential connection_id=%s reason=%s.",
            connection_id,
            rejection_reason,
        )
        await websocket.close(code=1008)
        return

    logger.info(
        "Protocol v2 accepted connection_id=%s remote=%s authenticated=%s.",
        connection_id,
        websocket.client.host if websocket.client else "unknown",
        authenticated is not None,
    )
    await websocket.accept(subprotocol="pocketdeck.v2")
    if authenticated is None:
        try:
            raw = await websocket.receive_text()
            logger.info(
                "Protocol v2 received first message connection_id=%s bytes=%s.",
                connection_id,
                len(raw.encode("utf-8")),
            )
            if len(raw.encode("utf-8")) > MAX_CONTROL_MESSAGE_BYTES:
                await _error(websocket, "message_too_large", "Pairing messages exceed 16 KiB.")
                await websocket.close(code=1009)
                return
            message, _, _, payload = _envelope(raw)
            versions = payload.get("supported_protocol_versions")
            configuration_versions = payload.get("supported_configuration_versions")
            transport = payload.get("transport", "wifi")
            pairing_code = payload.get("pairing_code")
            required_fields = {
                "pairing_code",
                "device_name",
                "client_type",
                "supported_protocol_versions",
                "supported_configuration_versions",
            }
            valid_transport = transport in {"wifi", "usb"}
            valid_transport_peer = (
                transport != "usb"
                or (
                    websocket.client is not None
                    and ipaddress.ip_address(websocket.client.host).is_loopback
                )
            )
            valid_pairing_code = (
                pairing_code == ""
                if transport == "usb"
                else isinstance(pairing_code, str)
                and pairing_code.isascii()
                and pairing_code.isdecimal()
                and len(pairing_code) == PAIRING_CODE_DIGITS
            )
            if (
                message["type"] != "pairing.claim"
                or not required_fields.issubset(payload)
                or set(payload) - required_fields - {"transport"}
                or payload.get("client_type") != "android"
                or not valid_transport
                or not valid_transport_peer
                or not isinstance(versions, list)
                or any(type(version) is not int for version in versions)
                or 2 not in versions
                or not isinstance(configuration_versions, list)
                or any(type(version) is not int for version in configuration_versions)
                or 2 not in configuration_versions
                or not isinstance(pairing_code, str)
                or not isinstance(payload.get("device_name"), str)
                or not valid_pairing_code
                or not 1 <= len(payload["device_name"]) <= 48
            ):
                logger.warning(
                    "Protocol v2 rejected pairing envelope connection_id=%s "
                    "type=%r payload_fields=%s client_type=%r protocol_versions=%r "
                    "configuration_versions=%r pairing_code_length=%s "
                    "device_name_length=%s.",
                    connection_id,
                    message.get("type"),
                    sorted(payload),
                    payload.get("client_type"),
                    versions,
                    configuration_versions,
                    len(pairing_code)
                    if isinstance(pairing_code, str)
                    else None,
                    len(payload["device_name"])
                    if isinstance(payload.get("device_name"), str)
                    else None,
                )
                await _error(websocket, "unsupported_protocol", "Unsupported pairing request.")
                await websocket.close(code=1008)
                return
            logger.info(
                "Protocol v2 validated pairing claim connection_id=%s message_id=%s.",
                connection_id,
                message["message_id"],
            )
            await _pair(
                websocket,
                pairing_code,
                payload["device_name"],
                transport,
            )
        except WebSocketDisconnect:
            logger.info(
                "Protocol v2 disconnected before pairing claim connection_id=%s.",
                connection_id,
            )
            return
        except (json.JSONDecodeError, ValueError, TypeError) as error:
            logger.warning(
                "Protocol v2 rejected first pairing message connection_id=%s "
                "error_type=%s.",
                connection_id,
                type(error).__name__,
            )
            await _error(websocket, "invalid_message", str(error))
            await websocket.close(code=1003)
        return

    device = authenticated.device
    await websocket.app.state.pairing_websocket_manager.register_session(
        websocket, device.device_id
    )
    session_started_at = time.monotonic()
    authentication_started_at = session_started_at
    close_code: int | None = None
    try:
        raw = await websocket.receive_text()
        message, hello_id, _, payload = _envelope(raw)
        supported_protocols = payload.get("supported_protocol_versions")
        supported_configurations = payload.get("supported_configuration_versions")
        if (
            message["type"] != "client.hello"
            or set(payload)
            != {
                "device_id",
                "supported_protocol_versions",
                "supported_configuration_versions",
            }
            or payload.get("device_id") != device.device_id
            or not isinstance(supported_protocols, list)
            or any(type(version) is not int for version in supported_protocols)
            or 2 not in supported_protocols
            or not isinstance(supported_configurations, list)
            or any(type(version) is not int for version in supported_configurations)
            or 2 not in supported_configurations
        ):
            await _error(websocket, "unauthorized", "The authenticated device hello is invalid.")
            await websocket.close(code=1008)
            return

        state = websocket.app.state
        revision, _ = _configuration_snapshot(websocket)
        session_id = str(uuid4())
        await _send(
            websocket,
            "server.welcome",
            {
                "session_id": session_id,
                "server_id": state.windows_identity.server_id,
                "selected_protocol_version": 2,
                "selected_configuration_version": 2,
                "head": {
                    "config_epoch": state.windows_identity.config_epoch,
                    "revision": revision,
                },
            },
            in_reply_to=hello_id,
        )
        logger.info(
            "Protocol v2 device authenticated connection_id=%s device_id=%s "
            "elapsed_ms=%s.",
            connection_id,
            device.device_id,
            int((time.monotonic() - authentication_started_at) * 1000),
        )

        raw = await websocket.receive_text()
        message, sync_id, _, payload = _envelope(raw)
        if (
            message["type"] != "config.sync"
            or set(payload) - {"last_accepted", "force_snapshot"}
            or "last_accepted" not in payload
            or (
                payload["last_accepted"] is not None
                and (
                    not isinstance(payload["last_accepted"], dict)
                    or set(payload["last_accepted"]) != {"config_epoch", "revision"}
                    or not isinstance(payload["last_accepted"]["config_epoch"], str)
                    or type(payload["last_accepted"]["revision"]) is not int
                    or not 0 <= payload["last_accepted"]["revision"] <= 9007199254740991
                )
            )
            or (
                "force_snapshot" in payload
                and type(payload["force_snapshot"]) is not bool
            )
        ):
            await _error(
                websocket,
                "invalid_message",
                "The configuration sync request is invalid.",
                in_reply_to=sync_id,
            )
            await websocket.close(code=1008)
            return

        sync_started_at = time.monotonic()
        revision, configuration = _configuration_snapshot(websocket)
        sync_epoch = state.windows_identity.config_epoch
        last_accepted = payload["last_accepted"]
        force_snapshot = payload.get("force_snapshot", False)
        cached_revision_is_current = (
            not force_snapshot
            and isinstance(last_accepted, dict)
            and last_accepted
            == {"config_epoch": sync_epoch, "revision": revision}
        )
        if cached_revision_is_current:
            await _send(
                websocket,
                "config.synced",
                {"config_epoch": sync_epoch, "revision": revision},
                in_reply_to=sync_id,
            )
        else:
            await _send(
                websocket,
                "config.snapshot",
                {
                    "config_epoch": sync_epoch,
                    "revision": revision,
                    "configuration": configuration,
                },
                in_reply_to=sync_id,
            )
        logger.info(
            "Protocol v2 configuration synchronization completed "
            "connection_id=%s device_id=%s snapshot_sent=%s revision=%s "
            "elapsed_ms=%s.",
            connection_id,
            device.device_id,
            not cached_revision_is_current,
            revision,
            int((time.monotonic() - sync_started_at) * 1000),
        )

        last_revision = revision
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_CONTROL_MESSAGE_BYTES:
                await _error(websocket, "message_too_large", "Control messages exceed 16 KiB.")
                await websocket.close(code=1009)
                return
            if token is None or authenticate_token(websocket.app, token) is None:
                await websocket.close(code=1008)
                return
            message, message_id, _, payload = _envelope(raw)
            if message["type"] == "action.execute":
                result = await _execute_action(
                    websocket,
                    message_id,
                    payload,
                )
                await _send(websocket, "action.result", result, in_reply_to=message_id)
                continue
            if message["type"] == "configuration.upload.result":
                outcome = payload.get("outcome")
                detail = payload.get("message")
                if (
                    message.get("in_reply_to") is None
                    or set(payload) != {"outcome", "message"}
                    or outcome not in {"succeeded", "failed"}
                    or not isinstance(detail, str)
                    or len(detail) > 512
                ):
                    await _error(
                        websocket,
                        "invalid_message",
                        "The configuration upload result is invalid.",
                        in_reply_to=message_id,
                    )
                    await websocket.close(code=1008)
                    return
                accepted = state.pairing_websocket_manager.complete_configuration_upload(
                    websocket,
                    device.device_id,
                    message["in_reply_to"],
                    {"outcome": outcome, "message": detail},
                )
                if not accepted:
                    logger.warning(
                        "Ignored unmatched configuration upload acknowledgement "
                        "device_id=%s message_id=%s.",
                        device.device_id,
                        message["in_reply_to"],
                    )
                continue
            if message["type"] != "client.ping" or payload:
                await _error(
                    websocket,
                    "invalid_message",
                    "Only client.ping is currently accepted after synchronization.",
                    in_reply_to=message_id,
                )
                await websocket.close(code=1003)
                return
            revision, configuration = _configuration_snapshot(websocket)
            head = {
                "config_epoch": state.windows_identity.config_epoch,
                "revision": revision,
            }
            await _send(
                websocket,
                "server.pong",
                {"head": head},
                in_reply_to=message_id,
            )
            if revision != last_revision:
                last_revision = revision
                await _send(
                    websocket,
                    "config.snapshot",
                    {
                        "config_epoch": state.windows_identity.config_epoch,
                        "revision": revision,
                        "configuration": configuration,
                    },
                )
    except WebSocketDisconnect as disconnect:
        close_code = disconnect.code
        return
    except (json.JSONDecodeError, ValueError, TypeError) as error:
        logger.info(
            "Closing invalid Protocol v2 connection connection_id=%s "
            "error_type=%s.",
            connection_id,
            type(error).__name__,
        )
        await _error(websocket, "invalid_message", str(error))
        await websocket.close(code=1003)
    finally:
        await websocket.app.state.pairing_websocket_manager.forget_session(websocket)
        logger.info(
            "Protocol v2 session closed connection_id=%s close_code=%s "
            "duration_ms=%s.",
            connection_id,
            close_code,
            int((time.monotonic() - session_started_at) * 1000),
        )
