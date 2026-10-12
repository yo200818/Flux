from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from app.config.models import Configuration, validate_configuration
from app.security import (
    AuthenticatedClient,
    require_configuration_read,
    require_configuration_write,
)
from app.config.storage import ConfigurationSnapshot

router = APIRouter(prefix="/api", tags=["configuration"])


class ConfigurationResponse(BaseModel):
    revision: int
    configuration: Configuration


@router.get(
    "/config",
    response_model=ConfigurationResponse,
    dependencies=[Depends(require_configuration_read)],
)
def get_configuration(request: Request) -> ConfigurationResponse:
    """Return the current persisted configuration and its revision."""
    snapshot: ConfigurationSnapshot = (
        request.app.state.configuration_manager.get_snapshot()
    )
    return ConfigurationResponse(
        revision=snapshot.revision,
        configuration=snapshot.configuration,
    )


@router.put("/config", response_model=ConfigurationResponse)
async def update_configuration(
    configuration_data: dict[str, Any],
    request: Request,
    _client: Annotated[AuthenticatedClient, Depends(require_configuration_write)],
    expected_revision: Annotated[int | None, Query(ge=0)] = None,
) -> ConfigurationResponse:
    """Validate, persist, and publish a configuration update."""
    configuration = validate_configuration(configuration_data)
    snapshot: ConfigurationSnapshot = request.app.state.configuration_manager.update(
        configuration, expected_revision
    )
    await request.app.state.websocket_manager.broadcast_configuration_updated(
        snapshot.revision
    )
    return ConfigurationResponse(
        revision=snapshot.revision,
        configuration=snapshot.configuration,
    )
