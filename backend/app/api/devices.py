from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from app.config.migration import ConfigurationMigrationError, migrate_v1_to_v2
from app.devices import PAIRING_CODE_DIGITS, DeviceClientType, DeviceInput, DevicePublic
from app.realtime import ConfigurationUploadError
from app.security import require_admin, require_device

router = APIRouter(tags=["devices"])


class PairingSessionResponse(BaseModel):
    session_id: str
    pairing_code: str
    expires_at: datetime


class PairingClaimRequest(DeviceInput):
    model_config = ConfigDict(extra="forbid")

    pairing_code: str = Field(pattern=rf"^[0-9]{{{PAIRING_CODE_DIGITS}}}$")


class PairingRequestResponse(BaseModel):
    request_id: str
    device_id: str
    name: str
    client_type: DeviceClientType
    transport: Literal["wifi", "usb"]
    created_at: datetime
    expires_at: datetime
    status: Literal["pending"]


class ApprovedDeviceResponse(BaseModel):
    device: DevicePublic
    credential: str | None


class ConfigurationUploadResponse(BaseModel):
    device_id: str
    config_epoch: str
    revision: int
    outcome: Literal["succeeded"]
    message: str


class DeviceListResponse(BaseModel):
    devices: list[DevicePublic]


class PairingRequestsResponse(BaseModel):
    requests: list[PairingRequestResponse]


@router.post(
    "/api/pairing/sessions",
    response_model=PairingSessionResponse,
    dependencies=[Depends(require_admin)],
)
def create_pairing_session(request: Request) -> PairingSessionResponse:
    session_id, pairing_code, expires_at = (
        request.app.state.pairing_manager.create_session()
    )
    return PairingSessionResponse(
        session_id=session_id,
        pairing_code=pairing_code,
        expires_at=expires_at,
    )


@router.post("/api/pairing/claim", response_model=PairingRequestResponse)
def claim_pairing_session(
    pairing: PairingClaimRequest,
    request: Request,
) -> PairingRequestResponse:
    pairing_request = request.app.state.pairing_manager.claim(
        pairing.pairing_code,
        pairing,
        client_key=request.client.host if request.client else "unknown",
    )
    return PairingRequestResponse(
        request_id=pairing_request.request_id,
        device_id=pairing_request.device_id,
        name=pairing_request.name,
        client_type=pairing_request.client_type,
        transport=pairing_request.transport,
        created_at=pairing_request.created_at,
        expires_at=pairing_request.expires_at,
        status=pairing_request.status,
    )


@router.get(
    "/api/pairing/requests",
    response_model=PairingRequestsResponse,
    dependencies=[Depends(require_admin)],
)
def list_pairing_requests(request: Request) -> PairingRequestsResponse:
    requests = request.app.state.pairing_manager.list_pending()
    return PairingRequestsResponse(
        requests=[
            PairingRequestResponse(
                request_id=item.request_id,
                device_id=item.device_id,
                name=item.name,
                client_type=item.client_type,
                transport=item.transport,
                created_at=item.created_at,
                expires_at=item.expires_at,
                status="pending",
            )
            for item in requests
        ]
    )


@router.post(
    "/api/devices/{device_id}/configuration/upload",
    response_model=ConfigurationUploadResponse,
    dependencies=[Depends(require_admin)],
)
async def upload_configuration_to_device(
    request: Request,
    device_id: str = Path(pattern=r"^[0-9a-f-]{36}$"),
) -> ConfigurationUploadResponse:
    device = request.app.state.device_registry.get(device_id)
    if (
        device is None
        or device.client_type != "android"
        or not device.is_authorized
        or device.is_revoked
    ):
        raise HTTPException(
            status_code=404,
            detail="An authorized Android device with that ID was not found.",
        )

    state = request.app.state
    snapshot = state.configuration_manager.get_snapshot()
    try:
        configuration = migrate_v1_to_v2(
            snapshot.configuration.model_dump(mode="json"),
            state.windows_identity.migration_namespace,
        )
    except ConfigurationMigrationError as error:
        raise HTTPException(
            status_code=500,
            detail="The current Windows configuration cannot be migrated for Android.",
        ) from error

    config_epoch = state.windows_identity.config_epoch
    try:
        result = await state.pairing_websocket_manager.upload_configuration(
            device_id,
            {
                "config_epoch": config_epoch,
                "revision": snapshot.revision,
                "configuration": configuration,
            },
        )
    except ConfigurationUploadError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=str(error),
        ) from error
    if result.get("outcome") != "succeeded":
        raise HTTPException(
            status_code=502,
            detail=str(result.get("message") or "Android did not save the configuration."),
        )
    return ConfigurationUploadResponse(
        device_id=device_id,
        config_epoch=config_epoch,
        revision=snapshot.revision,
        outcome="succeeded",
        message=str(result.get("message") or "Configuration saved on Android."),
    )


@router.post(
    "/api/pairing/requests/{request_id}/approve",
    response_model=ApprovedDeviceResponse,
    dependencies=[Depends(require_admin)],
)
async def approve_pairing_request(
    request: Request,
    request_id: str = Path(pattern=r"^[0-9a-f-]{36}$"),
) -> ApprovedDeviceResponse:
    credential = request.app.state.pairing_manager.approve(request_id)
    delivered_over_wss = await request.app.state.pairing_websocket_manager.deliver_approval(
        request_id, credential.device.device_id, credential.token
    )
    # Android receives its credential once over the already-pinned WSS connection.
    # Legacy clients retain the existing desktop-mediated enrollment flow.
    response_credential = None if delivered_over_wss else credential.token
    return ApprovedDeviceResponse(
        device=credential.device,
        credential=response_credential,
    )


@router.post(
    "/api/pairing/requests/{request_id}/reject",
    status_code=204,
    dependencies=[Depends(require_admin)],
)
async def reject_pairing_request(
    request: Request,
    request_id: str = Path(pattern=r"^[0-9a-f-]{36}$"),
) -> None:
    request.app.state.pairing_manager.reject(request_id)
    await request.app.state.pairing_websocket_manager.deliver_rejection(request_id)


@router.get(
    "/api/devices",
    response_model=DeviceListResponse,
    dependencies=[Depends(require_admin)],
)
def list_devices(request: Request) -> DeviceListResponse:
    return DeviceListResponse(devices=request.app.state.device_registry.list_devices())


@router.delete(
    "/api/devices/{device_id}",
    response_model=DevicePublic,
    dependencies=[Depends(require_admin)],
)
async def revoke_device(
    request: Request,
    device_id: str = Path(pattern=r"^[0-9a-f-]{36}$"),
) -> DevicePublic:
    device = request.app.state.device_registry.revoke(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device was not found.")
    await request.app.state.pairing_websocket_manager.disconnect_device(device_id)
    return device


@router.get("/api/devices/me", response_model=DevicePublic)
def get_authenticated_device(
    device: DevicePublic = Depends(require_device),
) -> DevicePublic:
    return device
