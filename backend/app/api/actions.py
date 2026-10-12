from fastapi import APIRouter, Depends, Path, Request

from app.actions.execution import (
    ActionExecutionResult,
    execute_configured_action,
)
from app.security import AuthenticatedClient, require_action_execution

router = APIRouter(prefix="/api/actions", tags=["actions"])


@router.post("/{action_id}/execute", response_model=ActionExecutionResult)
def execute_action(
    request: Request,
    action_id: str = Path(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    ),
    _client: AuthenticatedClient = Depends(require_action_execution),
) -> ActionExecutionResult:
    """Execute an explicitly enabled action assigned to a configured button."""
    configuration = request.app.state.configuration_manager.get_configuration()
    return execute_configured_action(configuration, action_id)
