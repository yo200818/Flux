from fastapi import APIRouter, WebSocket

from app.realtime import handle_websocket_messages
from app.security import authenticate_token

router = APIRouter(tags=["realtime"])


@router.websocket("/ws")
async def websocket_events(websocket: WebSocket) -> None:
    """Provide authenticated configuration revision notifications."""
    origin = websocket.headers.get("origin")
    allowed_origins = websocket.app.state.allowed_origins
    if origin is not None and origin not in allowed_origins:
        await websocket.close(code=1008)
        return

    protocols = websocket.headers.get("sec-websocket-protocol", "")
    offered_protocols = [item.strip() for item in protocols.split(",")]
    auth_tokens = [
        item.removeprefix("bearer.")
        for item in offered_protocols
        if item.startswith("bearer.")
    ]
    base_protocol_offered = "pocketdeck.v1" in offered_protocols
    if not base_protocol_offered or len(auth_tokens) != 1 or not auth_tokens[0]:
        await websocket.close(code=1008)
        return
    if authenticate_token(websocket.app, auth_tokens[0]) is None:
        await websocket.close(code=1008)
        return

    manager = websocket.app.state.websocket_manager
    configuration_manager = websocket.app.state.configuration_manager
    await handle_websocket_messages(
        websocket,
        manager,
        lambda: configuration_manager.get_snapshot().revision,
        auth_tokens[0],
        "pocketdeck.v1",
    )
