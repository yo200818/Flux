from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app

ADMIN_TOKEN = "security-test-admin-token-with-at-least-32-bytes"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
EXAMPLE_CONFIGURATION = {
    "schema_version": 1,
    "profiles": [
        {
            "id": "default",
            "name": "Default",
            "pages": [
                {
                    "id": "main",
                    "name": "Main",
                    "grid": {"columns": 1, "rows": 1},
                    "buttons": [
                        {
                            "id": "site-button",
                            "label": "Website",
                            "action_id": "open-site",
                        }
                    ],
                }
            ],
        }
    ],
    "actions": [
        {
            "id": "open-site",
            "type": "open_url",
            "enabled_for_execution": True,
            "parameters": {"url": "https://example.com/"},
        }
    ],
}


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(
            tmp_path / "configuration.json",
            device_store_path=tmp_path / "devices.json",
            admin_token=ADMIN_TOKEN,
        )
    )


def pair_device(
    client: TestClient,
    client_type: str,
) -> tuple[dict[str, str], str]:
    session_response = client.post(
        "/api/pairing/sessions",
        headers=ADMIN_HEADERS,
    )
    assert session_response.status_code == 200
    request_response = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session_response.json()["pairing_code"],
            "name": f"Security {client_type}",
            "client_type": client_type,
        },
    )
    assert request_response.status_code == 200
    approval_response = client.post(
        f"/api/pairing/requests/{request_response.json()['request_id']}/approve",
        headers=ADMIN_HEADERS,
    )
    assert approval_response.status_code == 200
    response = approval_response.json()
    return response["device"], response["credential"]


def test_unauthenticated_clients_cannot_read_write_execute_or_subscribe(
    client: TestClient,
) -> None:
    assert client.get("/api/config").status_code == 401
    assert client.put("/api/config", json=EXAMPLE_CONFIGURATION).status_code == 401
    with patch("app.actions.execution.webbrowser.open") as open_url:
        assert client.post("/api/actions/open-site/execute").status_code == 401
        open_url.assert_not_called()

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pytest.fail("Unauthenticated WebSocket connection was accepted.")


def test_authorized_devices_receive_role_limited_access(client: TestClient) -> None:
    web_device, web_credential = pair_device(client, "web")
    phone_device, phone_credential = pair_device(client, "android")
    web_headers = {"Authorization": f"Bearer {web_credential}"}
    phone_headers = {"Authorization": f"Bearer {phone_credential}"}

    assert client.get("/api/config", headers=web_headers).status_code == 200
    assert client.get("/api/config", headers=phone_headers).status_code == 200

    web_update = {
        **EXAMPLE_CONFIGURATION,
        "profiles": [
            {
                **EXAMPLE_CONFIGURATION["profiles"][0],
                "name": "Browser edit",
            }
        ],
    }
    assert (
        client.put(
            "/api/config",
            json=web_update,
            params={"expected_revision": 0},
            headers=web_headers,
        ).status_code
        == 200
    )
    assert (
        client.put(
            "/api/config",
            json=EXAMPLE_CONFIGURATION,
            headers=phone_headers,
        ).status_code
        == 403
    )

    with patch("app.actions.execution.webbrowser.open", return_value=True) as open_url:
        assert (
            client.post("/api/actions/open-site/execute", headers=phone_headers)
            .status_code
            == 200
        )
        open_url.assert_called_once_with("https://example.com/", new=2)

    assert client.get("/api/devices", headers=web_headers).status_code == 401
    assert web_device["client_type"] == "web"
    assert phone_device["client_type"] == "android"


@pytest.mark.parametrize("authorization", [None, "Bearer invalid-credential"])
def test_missing_or_invalid_credentials_are_rejected(
    client: TestClient,
    authorization: str | None,
) -> None:
    headers = {"Authorization": authorization} if authorization else {}
    assert client.get("/api/config", headers=headers).status_code == 401
    assert (
        client.post("/api/actions/open-site/execute", headers=headers).status_code
        == 401
    )


def test_revoked_credentials_are_rejected_and_disconnect_active_websockets(
    client: TestClient,
) -> None:
    device, credential = pair_device(client, "web")
    headers = {"Authorization": f"Bearer {credential}"}
    protocols = ["pocketdeck.v1", f"bearer.{credential}"]
    with client.websocket_connect("/ws", subprotocols=protocols) as websocket:
        assert websocket.receive_json()["type"] == "connection.ready"
        revoked = client.delete(
            f"/api/devices/{device['device_id']}",
            headers=ADMIN_HEADERS,
        )
        assert revoked.status_code == 200
        websocket.send_json({"protocol_version": 1, "type": "client.ping"})
        assert websocket.receive()["type"] == "websocket.close"

    assert client.get("/api/config", headers=headers).status_code == 401


def test_websocket_checks_origin_auth_and_message_size(client: TestClient) -> None:
    device, credential = pair_device(client, "web")
    protocols = ["pocketdeck.v1", f"bearer.{credential}"]

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws",
            subprotocols=protocols,
            headers={"Origin": "https://untrusted.example"},
        ):
            pytest.fail("Untrusted WebSocket origin was accepted.")

    with client.websocket_connect("/ws", subprotocols=protocols) as websocket:
        ready = websocket.receive_json()
        assert ready["type"] == "connection.ready"
        assert websocket.accepted_subprotocol == "pocketdeck.v1"
        websocket.send_text(" " * 4097)
        error = websocket.receive_json()
        assert error["type"] == "protocol.error"
        assert "4096 bytes" in error["payload"]["message"]
        assert websocket.receive()["type"] == "websocket.close"

