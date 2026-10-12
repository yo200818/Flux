from __future__ import annotations

import hmac
from dataclasses import dataclass

from fastapi import HTTPException, Request

from app.devices import DevicePublic, DeviceRegistry


@dataclass(frozen=True)
class AuthenticatedClient:
    device: DevicePublic | None

    @property
    def is_desktop_owner(self) -> bool:
        return self.device is None


def _bearer_token(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    scheme, separator, credential = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not credential:
        return None
    if credential != credential.strip() or " " in credential:
        return None
    return credential


def authenticate_client(request: Request) -> AuthenticatedClient:
    supplied = _bearer_token(request)
    if supplied is None:
        raise HTTPException(status_code=401, detail="PocketDeck authentication required.")

    client = authenticate_token(request.app, supplied)
    if client is None:
        raise HTTPException(
            status_code=401,
            detail="Device credential is invalid or revoked.",
        )
    return client


def authenticate_token(app: object, supplied: str) -> AuthenticatedClient | None:
    app_state = getattr(app, "state")
    configured_token: str | None = app_state.admin_token
    if configured_token is not None and hmac.compare_digest(
        supplied.encode("utf-8"),
        configured_token.encode("utf-8"),
    ):
        return AuthenticatedClient(device=None)

    registry: DeviceRegistry = app_state.device_registry
    device = registry.authenticate(supplied)
    if device is None:
        return None
    return AuthenticatedClient(device=device)


def require_admin(request: Request) -> None:
    configured_token: str | None = request.app.state.admin_token
    if configured_token is None:
        raise HTTPException(
            status_code=503,
            detail="Pairing administration is disabled; configure POCKETDECK_ADMIN_TOKEN.",
        )
    supplied = _bearer_token(request)
    if supplied is None or not hmac.compare_digest(
        supplied.encode("utf-8"),
        configured_token.encode("utf-8"),
    ):
        raise HTTPException(status_code=401, detail="Administrator authentication required.")


def require_configuration_read(request: Request) -> AuthenticatedClient:
    return authenticate_client(request)


def require_configuration_write(request: Request) -> AuthenticatedClient:
    client = authenticate_client(request)
    if client.is_desktop_owner or client.device.client_type in {"desktop", "web"}:
        return client
    raise HTTPException(
        status_code=403,
        detail="This paired client is not permitted to edit configuration.",
    )


def require_action_execution(request: Request) -> AuthenticatedClient:
    return authenticate_client(request)


def require_device(request: Request) -> DevicePublic:
    client = authenticate_client(request)
    if client.device is None:
        raise HTTPException(
            status_code=403,
            detail="This endpoint requires an authorized device credential.",
        )
    return client.device
