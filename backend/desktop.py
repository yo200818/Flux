import os
import logging
import socket
import threading
from pathlib import Path

import uvicorn

from app.main import app
from app.wifi import (
    bind_wifi_sockets,
    ensure_wifi_tls_identity,
    wifi_enabled,
    wifi_port,
    wifi_tls_context,
)

logger = logging.getLogger(__name__)


def _run_wifi_server(
    server: uvicorn.Server,
    sockets: list[socket.socket],
    port: int,
) -> None:
    try:
        server.run(sockets=sockets)
    except OSError as error:
        app.state.wifi_error = (
            f"PocketDeck could not bind the authenticated Wi-Fi listener on TCP "
            f"port {port}: {error}. Close other apps using that port and allow "
            "PocketDeck on Private networks only in Windows Defender Firewall."
        )
        logger.exception("PocketDeck authenticated Wi-Fi listener failed.")
    finally:
        for listener in sockets:
            listener.close()
    if not server.should_exit and not server.started:
        app.state.wifi_error = app.state.wifi_error or (
            "The authenticated Wi-Fi listener stopped during startup."
        )
        logger.error("PocketDeck Wi-Fi listener exited before becoming available.")


if __name__ == "__main__":
    wifi_server = None
    wifi_thread = None
    wifi_sockets: list[socket.socket] = []
    app.state.wifi_error = None
    app.state.wifi_server = None
    app.state.wifi_addresses = []
    try:
        data_directory = Path(
            os.environ.get(
                "POCKETDECK_WIFI_DATA_DIR",
                str(Path.home() / ".pocketdeck"),
            )
        )
        identity = ensure_wifi_tls_identity(data_directory)
        app.state.wifi_tls_identity = identity
        port = wifi_port()
        try:
            wifi_sockets = bind_wifi_sockets(port)
        except OSError as error:
            app.state.wifi_error = (
                f"PocketDeck could not bind authenticated Wi-Fi to the private "
                f"network on TCP port {port}: {error}. Close other apps using "
                "that port and allow PocketDeck on Private networks only in "
                "Windows Defender Firewall."
            )
            logger.exception("PocketDeck could not bind its private Wi-Fi addresses.")
            wifi_sockets = bind_wifi_sockets(port, include_lan=False)
        app.state.wifi_addresses = [
            str(listener.getsockname()[0])
            for listener in wifi_sockets
            if listener.getsockname()[0] != "127.0.0.1"
        ]
        if wifi_enabled() and not app.state.wifi_addresses and not app.state.wifi_error:
            app.state.wifi_error = (
                "No private LAN IPv4 address is available. Connect this PC to a "
                "private network and restart PocketDeck. USB reverse remains "
                "available on loopback."
            )
        wifi_config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            lifespan="off",
            reload=False,
        )
        wifi_config.load()
        wifi_config.ssl = wifi_tls_context(identity)
        wifi_server = uvicorn.Server(wifi_config)
        app.state.wifi_server = wifi_server
        wifi_thread = threading.Thread(
            target=_run_wifi_server,
            args=(wifi_server, wifi_sockets, port),
            daemon=True,
        )
        wifi_thread.start()
    except (OSError, RuntimeError, ValueError):
        app.state.wifi_error = (
            "The authenticated Windows connection listener could not start. "
            "Check PocketDeck's Wi-Fi certificate and TCP port permissions."
        )
        logger.exception("PocketDeck secure connection listener startup failed.")
        for listener in wifi_sockets:
            listener.close()
    try:
        uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)
    finally:
        if wifi_server is not None:
            wifi_server.should_exit = True
        if wifi_thread is not None:
            wifi_thread.join(timeout=10)
