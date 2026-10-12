import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared"
    / "examples"
    / "config.v1.json"
)
TEST_ADMIN_TOKEN = "test-admin-token-with-at-least-32-characters"
ADMIN_HEADERS = {"Authorization": f"Bearer {TEST_ADMIN_TOKEN}"}


def load_example() -> dict[str, Any]:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(
            tmp_path / "configuration.json",
            admin_token=TEST_ADMIN_TOKEN,
        ),
        headers=ADMIN_HEADERS,
    )


def connect_authenticated(client: TestClient):
    return client.websocket_connect(
        "/ws",
        subprotocols=["pocketdeck.v1", f"bearer.{TEST_ADMIN_TOKEN}"],
    )


def test_connection_ready_includes_protocol_and_current_revision(
    client: TestClient,
) -> None:
    with connect_authenticated(client) as websocket:
        ready = websocket.receive_json()

    assert ready["protocol_version"] == 1
    assert ready["type"] == "connection.ready"
    assert ready["revision"] == 0
    assert ready["event_id"]
    assert ready["payload"]["message"] == "PocketDeck event stream ready."


def test_connection_ready_uses_persisted_revision(client: TestClient) -> None:
    update = client.put(
        "/api/config",
        json=load_example(),
        params={"expected_revision": 0},
    )
    assert update.json()["revision"] == 1

    with connect_authenticated(client) as websocket:
        ready = websocket.receive_json()

    assert ready["type"] == "connection.ready"
    assert ready["revision"] == 1


def test_successful_persisted_update_broadcasts_to_all_clients(
    client: TestClient,
) -> None:
    with (
        connect_authenticated(client) as first,
        connect_authenticated(client) as second,
    ):
        first_ready = first.receive_json()
        second_ready = second.receive_json()
        configuration = load_example()
        configuration["profiles"][0]["name"] = "Updated Profile"

        response = client.put(
            "/api/config",
            json=configuration,
            params={"expected_revision": 0},
        )

        first_event = first.receive_json()
        second_event = second.receive_json()

    assert response.status_code == 200
    assert response.json()["revision"] == 1
    for event in (first_event, second_event):
        assert event["protocol_version"] == 1
        assert event["type"] == "config.updated"
        assert event["revision"] == 1
        assert event["event_id"]
        assert event["event_id"] != first_ready["event_id"]
        assert event["payload"] == {}


def test_invalid_update_does_not_broadcast(client: TestClient) -> None:
    with connect_authenticated(client) as websocket:
        websocket.receive_json()
        broadcaster = AsyncMock(
            wraps=client.app.state.websocket_manager.broadcast_configuration_updated
        )
        with patch.object(
            client.app.state.websocket_manager,
            "broadcast_configuration_updated",
            broadcaster,
        ):
            configuration = load_example()
            configuration["schema_version"] = 55
            response = client.put("/api/config", json=configuration)

        assert response.status_code == 422
        broadcaster.assert_not_awaited()


def test_failed_persist_does_not_broadcast(client: TestClient) -> None:
    with connect_authenticated(client) as websocket:
        websocket.receive_json()
        broadcaster = AsyncMock(
            wraps=client.app.state.websocket_manager.broadcast_configuration_updated
        )
        with (
            patch("app.config.storage.os.replace", side_effect=OSError("fail")),
            patch.object(
                client.app.state.websocket_manager,
                "broadcast_configuration_updated",
                broadcaster,
            ),
        ):
            response = client.put(
                "/api/config",
                json=load_example(),
                params={"expected_revision": 0},
            )

        assert response.status_code == 500
        broadcaster.assert_not_awaited()


def test_disconnect_removes_client_from_connection_manager(
    client: TestClient,
) -> None:
    manager = client.app.state.websocket_manager
    with connect_authenticated(client) as websocket:
        websocket.receive_json()
        assert manager.connection_count == 1

    assert manager.connection_count == 0


def test_unsupported_incoming_action_message_is_rejected(client: TestClient) -> None:
    with connect_authenticated(client) as websocket:
        websocket.receive_json()
        with patch("app.actions.execution.webbrowser.open") as open_url:
            websocket.send_json(
                {
                    "protocol_version": 1,
                    "type": "action.execute",
                    "payload": {"action_id": "action-open-pocketdeck-site"},
                }
            )
            error = websocket.receive_json()
        assert error["type"] == "protocol.error"
        assert "Only client.ping is accepted" in error["payload"]["message"]
        open_url.assert_not_called()
