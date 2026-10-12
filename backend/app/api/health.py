import os
from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["health"])


class HealthResponse(BaseModel):
    service: Literal["PocketDeck Backend"]
    status: Literal["healthy"]


@router.get("/health", response_model=HealthResponse)
def get_health(request: Request, response: Response) -> HealthResponse:
    """Report that the backend process is running."""
    expected_process_id = request.headers.get(
        "X-PocketDeck-Expected-Process-Id"
    )
    if expected_process_id == str(os.getpid()):
        response.headers["X-PocketDeck-Process-Id"] = expected_process_id
    return HealthResponse(service="PocketDeck Backend", status="healthy")
