from __future__ import annotations

from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app

ADMIN_TOKEN = "logo-asset-test-admin-token-at-least-32-bytes"
AUTH_HEADERS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


def create_png(width: int = 48, height: int = 32) -> bytes:
    output = BytesIO()
    Image.new("RGBA", (width, height), (80, 100, 240, 160)).save(output, "PNG")
    return output.getvalue()


def make_client(tmp_path: Path) -> TestClient:
    app = create_app(
        tmp_path / "configuration.json",
        device_store_path=tmp_path / "devices.json",
        admin_token=ADMIN_TOKEN,
    )
    return TestClient(app)


def test_logo_upload_generates_authenticated_bounded_webp_thumbnail(
    tmp_path: Path,
) -> None:
    with make_client(tmp_path) as client:
        uploaded = client.post(
            "/api/logo-assets",
            content=create_png(2048, 1024),
            headers={**AUTH_HEADERS, "Content-Type": "image/png"},
        )
        assert uploaded.status_code == 201
        result = uploaded.json()
        assert result["asset_id"].startswith("logo_")
        assert len(result["asset_id"]) == 37
        assert result["content_type"] == "image/webp"
        assert result["width"] <= 384
        assert result["height"] <= 384

        preview = client.get(
            f"/api/logo-assets/{result['asset_id']}",
            headers=AUTH_HEADERS,
        )
        assert preview.status_code == 200
        assert preview.headers["content-type"] == "image/webp"
        assert preview.headers["x-content-type-options"] == "nosniff"
        assert preview.headers["cache-control"] == "private, max-age=86400"
        with Image.open(BytesIO(preview.content)) as thumbnail:
            assert thumbnail.format == "WEBP"
            assert max(thumbnail.size) <= 384
            assert thumbnail.mode == "RGBA"


def test_logo_asset_endpoints_require_authentication(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        assert client.post(
            "/api/logo-assets",
            content=create_png(),
            headers={"Content-Type": "image/png"},
        ).status_code == 401
        assert client.get("/api/logo-assets/logo_" + "a" * 32).status_code == 401


def test_logo_upload_rejects_unsupported_or_mismatched_content(
    tmp_path: Path,
) -> None:
    with make_client(tmp_path) as client:
        unsupported = client.post(
            "/api/logo-assets",
            content=b"<svg/>",
            headers={**AUTH_HEADERS, "Content-Type": "image/svg+xml"},
        )
        mismatched = client.post(
            "/api/logo-assets",
            content=create_png(),
            headers={**AUTH_HEADERS, "Content-Type": "image/jpeg"},
        )
        invalid = client.post(
            "/api/logo-assets",
            content=b"not an image",
            headers={**AUTH_HEADERS, "Content-Type": "image/png"},
        )
        assert unsupported.status_code == 422
        assert mismatched.status_code == 422
        assert invalid.status_code == 422


def test_logo_upload_rejects_excessive_dimensions_and_body_size(
    tmp_path: Path,
) -> None:
    with make_client(tmp_path) as client:
        oversized_dimensions = client.post(
            "/api/logo-assets",
            content=create_png(4097, 1),
            headers={**AUTH_HEADERS, "Content-Type": "image/png"},
        )
        oversized_body = client.post(
            "/api/logo-assets",
            content=b"x" * (5 * 1024 * 1024 + 1),
            headers={**AUTH_HEADERS, "Content-Type": "image/png"},
        )
        assert oversized_dimensions.status_code == 422
        assert oversized_body.status_code == 413


def test_missing_or_invalid_asset_reference_returns_safe_error(
    tmp_path: Path,
) -> None:
    with make_client(tmp_path) as client:
        assert client.get(
            "/api/logo-assets/logo_" + "b" * 32,
            headers=AUTH_HEADERS,
        ).status_code == 404
        assert client.get(
            "/api/logo-assets/../configuration",
            headers=AUTH_HEADERS,
        ).status_code in {400, 404}
