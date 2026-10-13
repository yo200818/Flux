from __future__ import annotations

import hashlib
import io

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from PIL import Image
from pydantic import BaseModel

from app.assets.logo_storage import (
    MAX_LOGO_UPLOAD_BYTES,
    LogoAssetError,
    LogoAssetStore,
)
from app.security import (
    AuthenticatedClient,
    require_configuration_read,
    require_configuration_write,
)

router = APIRouter(prefix="/api/logo-assets", tags=["logo assets"])


class LogoAssetResponse(BaseModel):
    asset_id: str
    content_type: str = "image/webp"
    width: int
    height: int


@router.post("", response_model=LogoAssetResponse, status_code=201)
async def upload_logo_asset(
    request: Request,
    _client: AuthenticatedClient = Depends(require_configuration_write),
) -> LogoAssetResponse:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_LOGO_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Logo upload exceeds 5 MiB.")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Content-Length is invalid.") from error

    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_LOGO_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Logo upload exceeds 5 MiB.")
        chunks.append(chunk)

    store: LogoAssetStore = request.app.state.logo_asset_store
    try:
        asset_id, thumbnail, _etag = store.save(
            b"".join(chunks),
            request.headers.get("content-type", ""),
        )
    except LogoAssetError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    with Image.open(io.BytesIO(thumbnail)) as image:
        width, height = image.size
    return LogoAssetResponse(asset_id=asset_id, width=width, height=height)


@router.get("/{asset_id}")
def get_logo_asset(
    asset_id: str,
    request: Request,
    _client: AuthenticatedClient = Depends(require_configuration_read),
) -> Response:
    store: LogoAssetStore = request.app.state.logo_asset_store
    try:
        thumbnail = store.read(asset_id)
    except LogoAssetError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Logo asset was not found.") from error

    etag = hashlib.sha256(thumbnail).hexdigest()
    return Response(
        content=thumbnail,
        media_type="image/webp",
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": f'"{etag}"',
            "X-Content-Type-Options": "nosniff",
        },
    )
