from __future__ import annotations

import ipaddress
import socket
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from desktop import _wifi_listener_needs_restart
from app.main import create_app
from app.wifi import (
    WIFI_ENABLED_ENV,
    bind_wifi_sockets,
    ensure_wifi_tls_identity,
    wifi_bind_addresses,
    wifi_enabled,
    wifi_tls_context,
)


def test_wifi_is_disabled_without_explicit_activation(monkeypatch) -> None:
    monkeypatch.delenv(WIFI_ENABLED_ENV, raising=False)

    assert not wifi_enabled()
    assert wifi_bind_addresses() == ["127.0.0.1"]


def test_enabled_wifi_binds_loopback_and_private_addresses_only(monkeypatch) -> None:
    monkeypatch.setenv(WIFI_ENABLED_ENV, "1")
    monkeypatch.setattr(
        "app.wifi._local_ip_addresses",
        lambda: [
            ipaddress.ip_address("192.168.1.7"),
            ipaddress.ip_address("10.0.0.8"),
            ipaddress.ip_address("8.8.8.8"),
            ipaddress.ip_address("169.254.0.2"),
            ipaddress.ip_address("127.0.0.2"),
        ],
    )

    assert wifi_enabled()
    assert wifi_bind_addresses() == [
        "127.0.0.1",
        "192.168.1.7",
        "10.0.0.8",
    ]


def test_wifi_listener_refreshes_when_private_addresses_change_or_stop() -> None:
    assert not _wifi_listener_needs_restart(
        ["192.168.1.7", "10.0.0.8"],
        ["10.0.0.8", "192.168.1.7"],
        server_running=True,
    )
    assert _wifi_listener_needs_restart(
        ["192.168.1.7"],
        ["192.168.1.8"],
        server_running=True,
    )
    assert _wifi_listener_needs_restart(
        ["192.168.1.7"],
        ["192.168.1.7"],
        server_running=False,
    )


def test_disabled_listener_is_active_on_loopback_only(monkeypatch) -> None:
    monkeypatch.delenv(WIFI_ENABLED_ENV, raising=False)
    monkeypatch.setattr(
        "app.wifi._local_ip_addresses",
        lambda: pytest.fail("Disabled Wi-Fi must not enumerate LAN interfaces."),
    )

    listeners = bind_wifi_sockets(0)
    try:
        assert [listener.getsockname()[0] for listener in listeners] == ["127.0.0.1"]
        with socket.create_connection(listeners[0].getsockname(), timeout=1):
            pass
    finally:
        for listener in listeners:
            listener.close()


def test_wifi_status_requires_admin_and_reports_listener_failure(
    tmp_path,
    monkeypatch,
) -> None:
    admin_token = "wifi-status-test-admin-token-with-32-characters"
    app = create_app(
        tmp_path / "configuration.json",
        device_store_path=tmp_path / "devices.json",
        admin_token=admin_token,
    )
    app.state.wifi_tls_identity = ensure_wifi_tls_identity(tmp_path / "tls")
    app.state.wifi_server = SimpleNamespace(started=True)
    app.state.wifi_addresses = ["192.168.1.7"]
    app.state.wifi_error = (
        "Allow PocketDeck on Private networks only in Windows Defender Firewall."
    )
    monkeypatch.setenv(WIFI_ENABLED_ENV, "1")

    with TestClient(app) as client:
        assert client.get("/api/wifi/status").status_code == 401

        response = client.get(
            "/api/wifi/status",
            headers={"Authorization": f"Bearer {admin_token}"},
        )

    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert response.json()["loopback_available"] is True
    assert response.json()["addresses"] == ["192.168.1.7"]
    assert "Private networks only" in response.json()["error"]


def test_tls_identity_is_stable_and_context_is_tls_server(tmp_path) -> None:
    first = ensure_wifi_tls_identity(tmp_path)
    second = ensure_wifi_tls_identity(tmp_path)

    assert first.fingerprint == second.fingerprint
    assert first.certificate_path == second.certificate_path
    assert first.private_key_path == second.private_key_path
    assert wifi_tls_context(first).minimum_version.name == "TLSv1_2"


def test_tls_identity_refuses_mismatched_certificate_and_key(tmp_path) -> None:
    identity = ensure_wifi_tls_identity(tmp_path)
    other = ensure_wifi_tls_identity(tmp_path / "other")
    identity.private_key_path.write_bytes(
        other.private_key_path.read_bytes()
    )

    with pytest.raises(RuntimeError, match="incomplete or invalid"):
        ensure_wifi_tls_identity(tmp_path)


def test_tls_identity_refuses_a_partial_certificate_pair(tmp_path) -> None:
    (tmp_path / "wifi-cert.pem").write_text("partial", encoding="utf-8")

    with pytest.raises(RuntimeError, match="incomplete or invalid"):
        ensure_wifi_tls_identity(tmp_path)
