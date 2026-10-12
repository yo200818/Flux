from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.security import require_admin
from app.wifi import WifiTlsIdentity, _local_ip_addresses, wifi_enabled, wifi_port

router = APIRouter(tags=["wifi"])


@router.get("/api/wifi/status", dependencies=[Depends(require_admin)])
def get_wifi_status(request: Request) -> dict[str, object]:
    identity: WifiTlsIdentity | None = getattr(
        request.app.state, "wifi_tls_identity", None
    )
    server = getattr(request.app.state, "wifi_server", None)
    addresses = getattr(request.app.state, "wifi_addresses", None)
    exposed_addresses = (
        addresses
        if addresses is not None
        else [str(address) for address in _local_ip_addresses()]
    )
    listener_started = server is not None and server.started
    listener_error = getattr(request.app.state, "wifi_error", None)
    loopback_available = identity is not None and listener_started
    listener_is_healthy = listener_error is None
    return {
        "enabled": (
            wifi_enabled()
            and loopback_available
            and listener_is_healthy
            and bool(exposed_addresses)
        ),
        "loopback_available": loopback_available,
        "addresses": exposed_addresses,
        "port": wifi_port(),
        "server_id": request.app.state.windows_identity.server_id,
        "certificate_sha256": identity.fingerprint if identity else None,
        "certificate_expires_at": (
            identity.expires_at_epoch_seconds if identity else None
        ),
        "error": listener_error
        or (
            "No private LAN address is listening. Connect this PC to a private "
            "network and restart PocketDeck."
            if wifi_enabled() and identity is not None and not exposed_addresses
            else (
                "The authenticated Wi-Fi listener is starting."
                if wifi_enabled() and identity is not None and not listener_started
                else None
            )
        ),
    }
