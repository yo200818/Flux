import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.devices import PAIRING_LIFETIME
from app.main import create_app

ADMIN_TOKEN = "test-admin-token-with-at-least-32-characters"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


class FakeClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


@pytest.fixture
def test_clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def client(tmp_path: Path, test_clock: FakeClock) -> TestClient:
    app = create_app(
        tmp_path / "configuration.json",
        device_store_path=tmp_path / "devices.json",
        admin_token=ADMIN_TOKEN,
        clock=test_clock,
    )
    return TestClient(app)


def create_pairing_session(client: TestClient) -> dict[str, str]:
    response = client.post("/api/pairing/sessions", headers=ADMIN_HEADERS)
    assert response.status_code == 200
    return response.json()


def claim_session(
    client: TestClient, pairing_code: str, *, name: str = "My Phone"
) -> dict[str, str]:
    response = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": pairing_code,
            "name": name,
            "client_type": "android",
        },
    )
    assert response.status_code == 200
    return response.json()


def approve_request(client: TestClient, request_id: str) -> dict[str, object]:
    response = client.post(
        f"/api/pairing/requests/{request_id}/approve",
        headers=ADMIN_HEADERS,
    )
    assert response.status_code == 200
    return response.json()


def test_pairing_session_expires_and_expired_entries_are_cleaned(
    client: TestClient,
    test_clock: FakeClock,
) -> None:
    session = create_pairing_session(client)
    expires_at = datetime.fromisoformat(session["expires_at"])
    assert expires_at == test_clock.current + PAIRING_LIFETIME

    test_clock.advance(PAIRING_LIFETIME)
    claim = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "Expired Phone",
            "client_type": "ios",
        },
    )

    assert claim.status_code == 404
    assert claim.json()["error"]["code"] == "invalid_pairing_code"
    assert client.get("/api/pairing/requests", headers=ADMIN_HEADERS).json() == {
        "requests": []
    }
    assert client.app.state.pairing_manager._sessions == {}


def test_pairing_pin_is_six_numeric_digits_and_active_pins_are_unique(
    client: TestClient,
) -> None:
    first = create_pairing_session(client)
    second = create_pairing_session(client)

    assert len(first["pairing_code"]) == 6
    assert first["pairing_code"].isascii() and first["pairing_code"].isdecimal()
    assert len(second["pairing_code"]) == 6
    assert second["pairing_code"].isascii() and second["pairing_code"].isdecimal()
    assert first["pairing_code"] != second["pairing_code"]


def test_pairing_code_is_single_use(client: TestClient) -> None:
    session = create_pairing_session(client)

    first_claim = claim_session(client, session["pairing_code"])
    reused = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "Second Phone",
            "client_type": "ios",
        },
    )

    assert first_claim["status"] == "pending"
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "pairing_code_used"


def test_invalid_pairing_code_and_invalid_device_fields_are_rejected(
    client: TestClient,
) -> None:
    invalid_code = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": "000000",
            "name": "Phone",
            "client_type": "android",
        },
    )
    assert invalid_code.status_code == 404
    assert invalid_code.json()["error"]["code"] == "invalid_pairing_code"

    session = create_pairing_session(client)
    invalid_name = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "   ",
            "client_type": "android",
        },
    )
    invalid_type = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "Phone",
            "client_type": "unknown",
        },
    )

    assert invalid_name.status_code == 422
    assert invalid_type.status_code == 422
    assert client.app.state.pairing_manager._sessions

    client_supplied_identity = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "Phone",
            "client_type": "android",
            "device_id": str(uuid4()),
        },
    )
    assert client_supplied_identity.status_code == 422


def test_approval_authorizes_device_and_returns_credential_once(
    client: TestClient,
) -> None:
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])
    approved = approve_request(client, pairing_request["request_id"])
    credential = str(approved["credential"])
    device = approved["device"]

    assert device["device_id"] == pairing_request["device_id"]
    assert device["name"] == "My Phone"
    assert device["client_type"] == "android"
    assert device["is_authorized"] is True
    assert device["is_revoked"] is False

    authenticated = client.get(
        "/api/devices/me",
        headers={"Authorization": f"Bearer {credential}"},
    )
    assert authenticated.status_code == 200
    assert authenticated.json() == device
    assert "credential" not in authenticated.json()
    assert "credential_hash" not in authenticated.json()

    devices_response = client.get("/api/devices", headers=ADMIN_HEADERS)
    assert credential not in devices_response.text
    assert "credential_hash" not in devices_response.text

    persisted_data = json.loads(
        (client.app.state.device_registry._store.path).read_text(encoding="utf-8")
    )
    assert credential not in json.dumps(persisted_data)
    assert persisted_data["devices"][0]["credential_hash"] != credential


def test_pairing_secrets_are_not_written_to_logs(
    client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])
    approved = approve_request(client, pairing_request["request_id"])

    assert session["pairing_code"] not in caplog.text
    assert approved["credential"] not in caplog.text


def test_rejected_pairing_never_authorizes_device(client: TestClient) -> None:
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])

    rejection = client.post(
        f"/api/pairing/requests/{pairing_request['request_id']}/reject",
        headers=ADMIN_HEADERS,
    )
    approval = client.post(
        f"/api/pairing/requests/{pairing_request['request_id']}/approve",
        headers=ADMIN_HEADERS,
    )

    assert rejection.status_code == 204
    assert approval.status_code == 409
    assert client.get("/api/devices", headers=ADMIN_HEADERS).json() == {
        "devices": []
    }


def test_pending_pairing_request_expires(
    client: TestClient, test_clock: FakeClock
) -> None:
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])
    test_clock.advance(PAIRING_LIFETIME)

    approval = client.post(
        f"/api/pairing/requests/{pairing_request['request_id']}/approve",
        headers=ADMIN_HEADERS,
    )

    assert approval.status_code == 404
    assert client.get("/api/pairing/requests", headers=ADMIN_HEADERS).json() == {
        "requests": []
    }


def test_device_credentials_persist_across_restart_and_revoke(
    tmp_path: Path,
    test_clock: FakeClock,
) -> None:
    config_path = tmp_path / "configuration.json"
    device_path = tmp_path / "devices.json"
    client = TestClient(
        create_app(
            config_path,
            device_store_path=device_path,
            admin_token=ADMIN_TOKEN,
            clock=test_clock,
        )
    )
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])
    approved = approve_request(client, pairing_request["request_id"])
    credential = str(approved["credential"])
    device_id = str(approved["device"]["device_id"])
    client.close()

    restarted = TestClient(
        create_app(
            config_path,
            device_store_path=device_path,
            admin_token=ADMIN_TOKEN,
            clock=test_clock,
        )
    )
    assert restarted.get(
        "/api/devices/me",
        headers={"Authorization": f"Bearer {credential}"},
    ).status_code == 200

    revoked = restarted.delete(
        f"/api/devices/{device_id}",
        headers=ADMIN_HEADERS,
    )
    after_revoke = restarted.get(
        "/api/devices/me",
        headers={"Authorization": f"Bearer {credential}"},
    )

    assert revoked.status_code == 200
    assert revoked.json()["is_authorized"] is False
    assert revoked.json()["is_revoked"] is True
    assert after_revoke.status_code == 401
    assert after_revoke.json()["error"]["code"] == "http_error"


def test_admin_endpoints_reject_missing_or_invalid_credentials(
    client: TestClient,
) -> None:
    unauthorized_responses = [
        client.post("/api/pairing/sessions"),
        client.get("/api/pairing/requests"),
        client.get("/api/devices"),
        client.delete(f"/api/devices/{uuid4()}"),
        client.post(f"/api/pairing/requests/{uuid4()}/approve"),
    ]

    assert [response.status_code for response in unauthorized_responses] == [
        401,
        401,
        401,
        401,
        401,
    ]
    invalid_admin = client.post(
        "/api/pairing/sessions",
        headers={"Authorization": "Bearer incorrect-admin-token"},
    )
    assert invalid_admin.status_code == 401


def test_failed_registry_write_does_not_authorize_device(
    client: TestClient,
) -> None:
    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])

    with patch("app.devices.os.replace", side_effect=OSError("disk failure")):
        approval = client.post(
            f"/api/pairing/requests/{pairing_request['request_id']}/approve",
            headers=ADMIN_HEADERS,
        )

    assert approval.status_code == 500
    assert approval.json()["error"]["code"] == "device_storage_error"
    assert client.get("/api/devices", headers=ADMIN_HEADERS).json() == {
        "devices": []
    }
    assert client.get("/api/pairing/requests", headers=ADMIN_HEADERS).json()[
        "requests"
    ][0]["request_id"] == pairing_request["request_id"]


def test_pairing_admin_api_is_disabled_without_configured_secret(
    tmp_path: Path,
) -> None:
    client = TestClient(
        create_app(
            tmp_path / "configuration.json",
            device_store_path=tmp_path / "devices.json",
        )
    )

    response = client.post("/api/pairing/sessions")

    assert response.status_code == 503
    assert "POCKETDECK_ADMIN_TOKEN" in response.json()["error"]["message"]


def test_revoked_and_invalid_device_credentials_are_rejected(
    client: TestClient,
) -> None:
    invalid = client.get(
        "/api/devices/me",
        headers={"Authorization": "Bearer not-a-valid-device-token"},
    )
    assert invalid.status_code == 401

    session = create_pairing_session(client)
    pairing_request = claim_session(client, session["pairing_code"])
    credential = approve_request(client, pairing_request["request_id"])["credential"]
    client.delete(
        f"/api/devices/{pairing_request['device_id']}",
        headers=ADMIN_HEADERS,
    )
    revoked = client.get(
        "/api/devices/me",
        headers={"Authorization": f"Bearer {credential}"},
    )

    assert revoked.status_code == 401


def test_pairing_limits_bound_sessions_requests_and_claim_attempts(
    client: TestClient,
    test_clock: FakeClock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.devices.MAX_PENDING_PAIRING_SESSIONS", 1)
    first_session = create_pairing_session(client)
    full_sessions = client.post("/api/pairing/sessions", headers=ADMIN_HEADERS)
    assert full_sessions.status_code == 429
    assert full_sessions.json()["error"]["code"] == "pairing_capacity_reached"

    monkeypatch.setattr("app.devices.MAX_PENDING_PAIRING_SESSIONS", 2)
    second_session = create_pairing_session(client)
    first_request = claim_session(client, first_session["pairing_code"])
    monkeypatch.setattr("app.devices.MAX_PENDING_PAIRING_REQUESTS", 1)
    full_requests = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": second_session["pairing_code"],
            "name": "Second device",
            "client_type": "web",
        },
    )
    assert full_requests.status_code == 429
    assert full_requests.json()["error"]["code"] == "pairing_capacity_reached"
    assert sum(
        not session.claimed
        for session in client.app.state.pairing_manager._sessions.values()
    ) == 1
    assert first_request["status"] == "pending"

    client.app.state.pairing_manager._claim_attempts.clear()
    monkeypatch.setattr("app.devices.PAIRING_ATTEMPTS_PER_MINUTE", 1)
    invalid = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": "000000",
            "name": "Invalid device",
            "client_type": "web",
        },
    )
    limited = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": second_session["pairing_code"],
            "name": "Second device",
            "client_type": "web",
        },
    )
    assert invalid.status_code == 404
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "pairing_rate_limited"

    monkeypatch.setattr("app.devices.MAX_PENDING_PAIRING_REQUESTS", 2)
    test_clock.advance(timedelta(minutes=1))
    allowed_after_window = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": second_session["pairing_code"],
            "name": "Second device",
            "client_type": "web",
        },
    )
    assert allowed_after_window.status_code == 200


def test_pairing_rate_limit_state_has_a_bounded_client_key_count(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = create_pairing_session(client)
    monkeypatch.setattr("app.devices.MAX_PAIRING_RATE_LIMIT_KEYS", 0)

    response = client.post(
        "/api/pairing/claim",
        json={
            "pairing_code": session["pairing_code"],
            "name": "Browser",
            "client_type": "web",
        },
    )

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "pairing_rate_limited"
    assert client.app.state.pairing_manager._claim_attempts == {}
