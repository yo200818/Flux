from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import threading
from unittest.mock import AsyncMock, Mock, patch
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config.migration import migrate_v1_to_v2
from app.main import create_app
from app.realtime import PairingWebSocketManager
from fastapi import WebSocket

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_CONFIGURATION = json.loads(
    (REPOSITORY_ROOT / "shared" / "examples" / "config.v1.json").read_text(
        encoding="utf-8"
    )
)
ADMIN_TOKEN = "integration-admin-token-with-at-least-32-characters"


def _message(message_type: str, payload: dict[str, object]) -> dict[str, object]:
    return {
        "protocol_version": 2,
        "message_id": str(uuid4()),
        "type": message_type,
        "payload": payload,
    }


def _create_client(
    tmp_path: Path,
    client_address: tuple[str, int] = ("testclient", 50000),
) -> TestClient:
    return TestClient(
        create_app(
            tmp_path / "configuration.json",
            device_store_path=tmp_path / "devices.json",
            admin_token=ADMIN_TOKEN,
        ),
        base_url="https://testserver",
        client=client_address,
    )


def _approve_android(client: TestClient) -> tuple[str, str]:
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    created = client.post("/api/pairing/sessions", headers=headers)
    assert created.status_code == 200
    claim = _message(
        "pairing.claim",
        {
            "pairing_code": created.json()["pairing_code"],
            "device_name": "Integration Android",
            "client_type": "android",
            "supported_protocol_versions": [2],
            "supported_configuration_versions": [2],
        },
    )
    with client.websocket_connect(
        "wss://testserver/ws/v2",
        subprotocols=["pocketdeck.v2"],
    ) as socket:
        socket.send_json(claim)
        pending = socket.receive_json()
        assert pending["type"] == "pairing.pending"
        request_id = pending["payload"]["request_id"]
        request = client.get("/api/pairing/requests", headers=headers)
        assert request.status_code == 200
        assert request.json()["requests"][0]["request_id"] == request_id
        approved = client.post(
            f"/api/pairing/requests/{request_id}/approve",
            headers=headers,
        )
        assert approved.status_code == 200
        credential_message = socket.receive_json()
        assert credential_message["type"] == "pairing.approved"
        assert credential_message["payload"]["request_id"] == request_id
        assert approved.json()["credential"] is None
        return (
            credential_message["payload"]["device_id"],
            credential_message["payload"]["credential"],
        )
    raise AssertionError("Pairing socket exited before returning its credential.")


def _connect_authenticated(client: TestClient, device_id: str, credential: str):
    return client.websocket_connect(
        "wss://testserver/ws/v2",
        subprotocols=["pocketdeck.v2"],
        headers={"Authorization": f"Bearer {credential}"},
    )


def test_usb_pairing_is_pinless_but_waits_for_windows_approval(
    tmp_path: Path,
) -> None:
    client = _create_client(tmp_path, client_address=("127.0.0.1", 50000))
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    claim = _message(
        "pairing.claim",
        {
            "pairing_code": "",
            "transport": "usb",
            "device_name": "USB Android",
            "client_type": "android",
            "supported_protocol_versions": [2],
            "supported_configuration_versions": [2],
        },
    )
    with client.websocket_connect(
        "wss://testserver/ws/v2",
        subprotocols=["pocketdeck.v2"],
    ) as socket:
        socket.send_json(claim)
        pending = socket.receive_json()
        assert pending["type"] == "pairing.pending"
        request_id = pending["payload"]["request_id"]
        requests = client.get("/api/pairing/requests", headers=headers)
        assert requests.status_code == 200, requests.text
        assert requests.json()["requests"][0]["transport"] == "usb"

        approved = client.post(
            f"/api/pairing/requests/{request_id}/approve",
            headers=headers,
        )
        assert approved.status_code == 200
        credential = socket.receive_json()
        assert credential["type"] == "pairing.approved"
        assert credential["payload"]["credential"]

    device_id = credential["payload"]["device_id"]
    with _connect_authenticated(
        client,
        device_id,
        credential["payload"]["credential"],
    ) as socket:
        socket.send_json(
            _message(
                "client.hello",
                {
                    "device_id": device_id,
                    "supported_protocol_versions": [2],
                    "supported_configuration_versions": [2],
                },
            )
        )
        assert socket.receive_json()["type"] == "server.welcome"


def test_usb_pairing_rejects_non_loopback_peer(tmp_path: Path) -> None:
    client = _create_client(tmp_path, client_address=("192.0.2.10", 50000))
    claim = _message(
        "pairing.claim",
        {
            "pairing_code": "",
            "transport": "usb",
            "device_name": "Remote Android",
            "client_type": "android",
            "supported_protocol_versions": [2],
            "supported_configuration_versions": [2],
        },
    )

    with client.websocket_connect(
        "wss://testserver/ws/v2",
        subprotocols=["pocketdeck.v2"],
    ) as socket:
        socket.send_json(claim)
        error = socket.receive_json()

    assert error["type"] == "protocol.error"
    assert error["payload"]["code"] == "unsupported_protocol"
    assert error["payload"]["message"] == "Unsupported pairing request."


def test_configuration_upload_waits_for_authenticated_device_ack(
    tmp_path: Path,
) -> None:
    client = _create_client(tmp_path)
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    device_id, credential = _approve_android(client)
    upload_responses: list[object] = []

    with _connect_authenticated(client, device_id, credential) as socket:
        socket.send_json(
            _message(
                "client.hello",
                {
                    "device_id": device_id,
                    "supported_protocol_versions": [2],
                    "supported_configuration_versions": [2],
                },
            )
        )
        socket.receive_json()
        socket.send_json(
            _message("config.sync", {"last_accepted": None})
        )
        socket.receive_json()

        def upload_from_desktop() -> None:
            with TestClient(client.app, base_url="https://testserver") as upload_client:
                upload_responses.append(
                    upload_client.post(
                        f"/api/devices/{device_id}/configuration/upload",
                        headers=headers,
                    )
                )

        upload_thread = threading.Thread(target=upload_from_desktop)
        upload_thread.start()
        upload = socket.receive_json()
        assert upload["type"] == "configuration.upload"
        assert upload["payload"]["configuration"]["schema_version"] == 2
        socket.send_json(
            {
                **_message(
                    "configuration.upload.result",
                    {
                        "outcome": "succeeded",
                        "message": "Saved atomically.",
                    },
                ),
                "in_reply_to": upload["message_id"],
            }
        )
        upload_thread.join(timeout=5)
        assert not upload_thread.is_alive()

    response = upload_responses[0]
    assert response.status_code == 200
    assert response.json()["outcome"] == "succeeded"


def test_wss_pairing_and_initial_snapshot_use_v2_contract(tmp_path: Path) -> None:
    client = _create_client(tmp_path)
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    configuration = client.put("/api/config", json=EXAMPLE_CONFIGURATION, headers=headers)
    assert configuration.status_code == 200
    device_id, credential = _approve_android(client)

    with _connect_authenticated(client, device_id, credential) as socket:
        hello = _message(
            "client.hello",
            {
                "device_id": device_id,
                "supported_protocol_versions": [2],
                "supported_configuration_versions": [2],
            },
        )
        socket.send_json(hello)
        welcome = socket.receive_json()
        assert welcome["type"] == "server.welcome"
        assert welcome["in_reply_to"] == hello["message_id"]
        assert welcome["payload"]["selected_protocol_version"] == 2
        assert welcome["payload"]["selected_configuration_version"] == 2

        sync = _message(
            "config.sync",
            {"last_accepted": None, "force_snapshot": True},
        )
        socket.send_json(sync)
        snapshot = socket.receive_json()

    assert snapshot["type"] == "config.snapshot"
    assert snapshot["in_reply_to"] == sync["message_id"]
    assert snapshot["payload"]["revision"] == configuration.json()["revision"]
    migrated = snapshot["payload"]["configuration"]
    assert migrated["schema_version"] == 2
    assert migrated == migrate_v1_to_v2(
        EXAMPLE_CONFIGURATION,
        client.app.state.windows_identity.migration_namespace,
    )
    assert all(action["target"] == "windows_host" for action in migrated["actions"])


def test_reconnect_reuses_authorization_and_skips_an_unchanged_snapshot(
    tmp_path: Path,
) -> None:
    client = _create_client(tmp_path)
    device_id, credential = _approve_android(client)
    accepted_revision: dict[str, object] | None = None

    for expected_type in ("config.snapshot", "config.synced"):
        with _connect_authenticated(client, device_id, credential) as socket:
            hello = _message(
                "client.hello",
                {
                    "device_id": device_id,
                    "supported_protocol_versions": [2],
                    "supported_configuration_versions": [2],
                },
            )
            socket.send_json(hello)
            welcome = socket.receive_json()
            assert welcome["type"] == "server.welcome"
            head = welcome["payload"]["head"]
            sync = _message(
                "config.sync",
                {
                    "last_accepted": accepted_revision,
                    "force_snapshot": accepted_revision is None,
                },
            )
            socket.send_json(sync)
            response = socket.receive_json()

            assert response["type"] == expected_type
            assert response["in_reply_to"] == sync["message_id"]
            if expected_type == "config.snapshot":
                accepted_revision = {
                    "config_epoch": response["payload"]["config_epoch"],
                    "revision": response["payload"]["revision"],
                }
                assert accepted_revision == head
            else:
                assert response["payload"] == accepted_revision
                assert "configuration" not in response["payload"]
                ping = _message("client.ping", {})
                socket.send_json(ping)
                pong = socket.receive_json()
                assert pong["type"] == "server.pong"
                assert pong["in_reply_to"] == ping["message_id"]


def test_invalid_or_revoked_credentials_cannot_open_v2_session(
    tmp_path: Path,
    caplog,
) -> None:
    client = _create_client(tmp_path)
    device_id, credential = _approve_android(client)
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    response = client.delete(
        f"/api/devices/{device_id}",
        headers=headers,
    )
    assert response.status_code == 200
    caplog.set_level(logging.WARNING, logger="app.api.websocket_v2")
    try:
        with client.websocket_connect(
            "wss://testserver/ws/v2",
            subprotocols=["pocketdeck.v2"],
            headers={"Authorization": f"Bearer {credential}"},
        ):
            raise AssertionError("A revoked device credential was accepted.")
    except WebSocketDisconnect as error:
        assert error.code == 1008
    assert "reason=revoked_device" in caplog.text
    assert credential not in caplog.text


def test_windows_action_requires_current_assignment_and_deduplicates_requests(
    tmp_path: Path,
) -> None:
    client = _create_client(tmp_path)
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    updated = client.put(
        "/api/config",
        json=EXAMPLE_CONFIGURATION,
        params={"expected_revision": 0},
        headers=headers,
    )
    assert updated.status_code == 200
    device_id, credential = _approve_android(client)
    with (
        _connect_authenticated(client, device_id, credential) as socket,
        patch("app.actions.execution.webbrowser.open", return_value=True) as open_url,
    ):
        hello = _message(
            "client.hello",
            {
                "device_id": device_id,
                "supported_protocol_versions": [2],
                "supported_configuration_versions": [2],
            },
        )
        socket.send_json(hello)
        welcome = socket.receive_json()
        sync = _message("config.sync", {"last_accepted": None})
        socket.send_json(sync)
        snapshot = socket.receive_json()
        action = next(
            item
            for item in snapshot["payload"]["configuration"]["actions"]
            if item["id"] == "action-open-pocketdeck-site"
        )
        request = _message(
            "action.execute",
            {
                "button_id": "open-pocketdeck-site",
                "config_epoch": snapshot["payload"]["config_epoch"],
                "config_revision": snapshot["payload"]["revision"],
                "action": action,
            },
        )
        socket.send_json(request)
        result = socket.receive_json()
        assert result["type"] == "action.result"
        assert result["in_reply_to"] == request["message_id"]
        assert result["payload"]["outcome"] == "succeeded"
        socket.send_json(request)
        replay = socket.receive_json()
        assert replay["type"] == "action.result"
        assert replay["in_reply_to"] == request["message_id"]
        assert replay["payload"] == result["payload"]
        open_url.assert_called_once_with("https://example.com/", new=2)
        assert welcome["type"] == "server.welcome"


def test_non_tls_websocket_is_rejected(tmp_path: Path) -> None:
    client = TestClient(
        create_app(
            tmp_path / "configuration.json",
            device_store_path=tmp_path / "devices.json",
            admin_token=ADMIN_TOKEN,
        )
    )
    try:
        with client.websocket_connect(
            "ws://testserver/ws/v2",
            subprotocols=["pocketdeck.v2"],
        ):
            raise AssertionError("A plaintext websocket was accepted.")
    except WebSocketDisconnect as error:
        assert error.code == 1008


def test_pairing_credential_delivery_uses_the_claimant_event_loop(
    tmp_path: Path,
) -> None:
    manager = PairingWebSocketManager(tmp_path / "action-results.sqlite3")
    owner_loop = asyncio.new_event_loop()
    loop_thread = threading.Thread(target=owner_loop.run_forever, daemon=True)
    loop_thread.start()
    delivered: list[asyncio.AbstractEventLoop] = []
    websocket = Mock(spec=WebSocket)

    async def record_delivery(_message: dict[str, object]) -> None:
        delivered.append(asyncio.get_running_loop())

    websocket.send_json = AsyncMock(side_effect=record_delivery)
    try:
        asyncio.run_coroutine_threadsafe(
            manager.register("pairing-request", websocket),
            owner_loop,
        ).result(timeout=5)
        assert asyncio.run(
            manager.deliver_approval("pairing-request", "device-id", "credential")
        )
        assert delivered == [owner_loop]
    finally:
        owner_loop.call_soon_threadsafe(owner_loop.stop)
        loop_thread.join(timeout=5)
        owner_loop.close()
