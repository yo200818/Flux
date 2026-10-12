import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import app, register_error_handlers

client = TestClient(app)
validation_app = FastAPI()
register_error_handlers(validation_app)


@validation_app.get("/items/{item_id}")
def get_item(item_id: int) -> dict[str, int]:
    return {"item_id": item_id}


validation_client = TestClient(validation_app)


def test_health_reports_backend_as_healthy() -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "service": "PocketDeck Backend",
        "status": "healthy",
    }


def test_health_echoes_the_process_id_only_for_the_owning_desktop() -> None:
    process_id = str(os.getpid())

    response = client.get(
        "/api/health",
        headers={"X-PocketDeck-Expected-Process-Id": process_id},
    )
    unrelated_response = client.get(
        "/api/health",
        headers={"X-PocketDeck-Expected-Process-Id": "another-process"},
    )

    assert response.headers["X-PocketDeck-Process-Id"] == process_id
    assert "X-PocketDeck-Process-Id" not in unrelated_response.headers


def test_health_allows_configured_frontend_origins() -> None:
    for origin in (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://tauri.localhost",
    ):
        response = client.get(
            "/api/health",
            headers={"Origin": origin},
        )

        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin


def test_health_does_not_allow_unconfigured_origin() -> None:
    response = client.get(
        "/api/health",
        headers={"Origin": "http://example.com"},
    )

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_http_errors_use_the_api_error_envelope() -> None:
    response = client.get("/api/not-found")

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "http_error",
            "message": "Not Found",
            "details": [],
        }
    }


def test_invalid_request_uses_the_validation_error_envelope() -> None:
    response = validation_client.get("/items/not-an-integer")

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert error["message"] == "Request validation failed."
    assert error["details"][0]["location"] == ["path", "item_id"]
