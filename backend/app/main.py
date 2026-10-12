import logging
import os
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.actions.execution import ActionExecutionError
from app.api.actions import router as actions_router
from app.api.configuration import router as configuration_router
from app.api.devices import router as devices_router
from app.api.health import router as health_router
from app.api.system import router as system_router
from app.api.websocket import router as websocket_router
from app.api.websocket_v2 import router as websocket_v2_router
from app.api.wifi import router as wifi_router
from app.config.defaults import load_default_configuration
from app.config.models import ConfigurationValidationError
from app.config.storage import (
    ConfigurationManager,
    ConfigurationRevisionConflict,
    ConfigurationStorageError,
    ConfigurationStore,
    get_default_configuration_path,
)
from app.devices import (
    ADMIN_TOKEN_ENV,
    DeviceRegistry,
    DeviceStorageError,
    DeviceStore,
    PairingError,
    PairingManager,
    get_default_device_store_path,
)
from app.realtime import PairingWebSocketManager, WebSocketConnectionManager
from app.system_metrics import WindowsSystemMetrics
from app.wifi import WIFI_IDENTITY_FILENAME, load_or_create_windows_identity

DEVELOPMENT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://tauri.localhost",
]
CORS_ORIGINS_ENV = "POCKETDECK_CORS_ORIGINS"
logger = logging.getLogger(__name__)


def register_error_handlers(app: FastAPI) -> None:
    """Register consistent client-error responses for API requests."""
    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        details = [
            {
                "location": list(error["loc"]),
                "message": error["msg"],
                "type": error["type"],
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "invalid_request",
                    "message": "Request validation failed.",
                    "details": details,
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": "http_error",
                    "message": str(exc.detail),
                    "details": [],
                }
            },
            headers=exc.headers,
        )

    @app.exception_handler(ConfigurationValidationError)
    async def configuration_validation_error_handler(
        _request: Request, exc: ConfigurationValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": exc.as_dict()},
        )

    @app.exception_handler(ActionExecutionError)
    async def action_execution_error_handler(
        _request: Request, exc: ActionExecutionError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.as_dict()},
        )

    @app.exception_handler(ConfigurationRevisionConflict)
    async def revision_conflict_error_handler(
        _request: Request, exc: ConfigurationRevisionConflict
    ) -> JSONResponse:
        return JSONResponse(status_code=409, content={"error": exc.as_dict()})

    @app.exception_handler(ConfigurationStorageError)
    async def configuration_storage_error_handler(
        _request: Request, exc: ConfigurationStorageError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"error": exc.as_dict()},
        )

    @app.exception_handler(DeviceStorageError)
    async def device_storage_error_handler(
        _request: Request, exc: DeviceStorageError
    ) -> JSONResponse:
        logger.exception("Device registry storage operation failed.", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "device_storage_error",
                    "message": str(exc),
                }
            },
        )

    @app.exception_handler(PairingError)
    async def pairing_error_handler(
        _request: Request, exc: PairingError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.as_dict()},
        )


def get_allowed_origins() -> list[str]:
    configured_origins = os.environ.get(CORS_ORIGINS_ENV, "")
    origins = list(DEVELOPMENT_ORIGINS)
    for raw_origin in configured_origins.split(","):
        origin = raw_origin.strip()
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                f"{CORS_ORIGINS_ENV} entries must be exact HTTP(S) origins."
            )
        normalized = f"{parsed.scheme}://{parsed.netloc}"
        if normalized not in origins:
            origins.append(normalized)
    return origins


def create_app(
    config_path: Path | None = None,
    *,
    device_store_path: Path | None = None,
    admin_token: str | None = None,
    clock: Callable[[], datetime] | None = None,
) -> FastAPI:
    """Create the PocketDeck FastAPI application."""
    app = FastAPI(title="PocketDeck Backend", version="0.1.0")

    allowed_origins = get_allowed_origins()
    app.state.allowed_origins = frozenset(allowed_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "PUT", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    register_error_handlers(app)
    app.state.websocket_manager = WebSocketConnectionManager()
    app.state.system_metrics = WindowsSystemMetrics()
    resolved_admin_token = (
        admin_token
        if admin_token is not None
        else os.environ.get(ADMIN_TOKEN_ENV)
    )
    if resolved_admin_token is not None and len(
        resolved_admin_token.encode("utf-8")
    ) < 32:
        raise ValueError("POCKETDECK_ADMIN_TOKEN must contain at least 32 bytes.")
    app.state.admin_token = resolved_admin_token
    configuration_path = config_path or get_default_configuration_path()
    app.state.windows_identity = load_or_create_windows_identity(
        configuration_path.with_name(WIFI_IDENTITY_FILENAME)
    )
    try:
        app.state.configuration_manager = ConfigurationManager(
            ConfigurationStore(configuration_path),
            load_default_configuration(),
        )
    except ConfigurationStorageError:
        logger.exception(
            "PocketDeck could not load or create its configuration file."
        )
        raise
    resolved_device_store_path = device_store_path or get_default_device_store_path()
    app.state.pairing_websocket_manager = PairingWebSocketManager(
        resolved_device_store_path.with_name("action-idempotency.sqlite3")
    )
    try:
        app.state.device_registry = DeviceRegistry(
            DeviceStore(resolved_device_store_path)
        )
    except DeviceStorageError:
        logger.exception("PocketDeck could not load its device registry.")
        raise
    app.state.pairing_manager = (
        PairingManager(app.state.device_registry, clock)
        if clock is not None
        else PairingManager(app.state.device_registry)
    )
    app.include_router(health_router)
    app.include_router(configuration_router)
    app.include_router(actions_router)
    app.include_router(system_router)
    app.include_router(devices_router)
    app.include_router(websocket_router)
    app.include_router(websocket_v2_router)
    app.include_router(wifi_router)
    return app


app = create_app()
