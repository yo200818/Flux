from __future__ import annotations

import hashlib
import io
import warnings
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_LOGO_DIMENSION = 4096
MAX_LOGO_PIXELS = 16_777_216
MAX_THUMBNAIL_BYTES = 512 * 1024
THUMBNAIL_EDGE = 384
SUPPORTED_LOGO_TYPES = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/webp": "WEBP",
}


class LogoAssetError(ValueError):
    """A logo upload did not meet the accepted image constraints."""


class LogoAssetStore:
    def __init__(self, directory: Path) -> None:
        self._directory = directory

    def save(self, data: bytes, content_type: str) -> tuple[str, bytes, str]:
        normalized_type = content_type.partition(";")[0].strip().lower()
        expected_format = SUPPORTED_LOGO_TYPES.get(normalized_type)
        if expected_format is None:
            raise LogoAssetError("Use a PNG, JPEG, or WebP image.")
        if not data or len(data) > MAX_LOGO_UPLOAD_BYTES:
            raise LogoAssetError("The image must be between 1 byte and 5 MiB.")

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as source:
                    if source.format != expected_format:
                        raise LogoAssetError(
                            "The image contents do not match the declared image type."
                        )
                    width, height = source.size
                    self._validate_dimensions(width, height)
                    source.verify()
                with Image.open(io.BytesIO(data)) as source:
                    source.load()
                    image = ImageOps.exif_transpose(source)
                    image.thumbnail(
                        (THUMBNAIL_EDGE, THUMBNAIL_EDGE),
                        Image.Resampling.LANCZOS,
                    )
                    image = image.convert(
                        "RGBA"
                        if "A" in image.getbands() or "transparency" in image.info
                        else "RGB"
                    )
                    output = io.BytesIO()
                    image.save(output, format="WEBP", quality=84, method=6)
        except LogoAssetError:
            raise
        except (
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            OSError,
            UnidentifiedImageError,
            ValueError,
        ) as error:
            raise LogoAssetError("The image is invalid or could not be decoded.") from error

        thumbnail = output.getvalue()
        if len(thumbnail) > MAX_THUMBNAIL_BYTES:
            raise LogoAssetError("The generated thumbnail exceeds the size limit.")

        asset_id = f"logo_{uuid4().hex}"
        destination = self._path_for(asset_id)
        self._directory.mkdir(parents=True, exist_ok=True)
        temporary = self._directory / f".{asset_id}.tmp"
        temporary.write_bytes(thumbnail)
        temporary.replace(destination)
        return asset_id, thumbnail, hashlib.sha256(thumbnail).hexdigest()

    def read(self, asset_id: str) -> bytes:
        return self._path_for(asset_id).read_bytes()

    @staticmethod
    def _validate_dimensions(width: int, height: int) -> None:
        if (
            width < 1
            or height < 1
            or width > MAX_LOGO_DIMENSION
            or height > MAX_LOGO_DIMENSION
            or width * height > MAX_LOGO_PIXELS
        ):
            raise LogoAssetError(
                "Images must be at most 4096 by 4096 and contain no more than 16 megapixels."
            )

    def _path_for(self, asset_id: str) -> Path:
        if len(asset_id) != 37 or not asset_id.startswith("logo_") or any(
            char not in "0123456789abcdef" for char in asset_id[5:]
        ):
            raise LogoAssetError("The logo asset reference is invalid.")
        return self._directory / f"{asset_id}.webp"
