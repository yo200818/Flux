from fastapi import APIRouter, Depends, Request

from app.security import AuthenticatedClient, require_action_execution
from app.system_metrics import SystemMetricsSnapshot

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/metrics", response_model=SystemMetricsSnapshot)
def get_system_metrics(
    request: Request,
    _client: AuthenticatedClient = Depends(require_action_execution),
) -> SystemMetricsSnapshot:
    """Return current read-only local telemetry to an authorized client."""
    return request.app.state.system_metrics.snapshot()
