import os
import logging
import socket
import threading
from pathlib import Path
from collections.abc import Sequence

import uvicorn

from app.main import app
from app.wifi import (
    WifiTlsIdentity,
    bind_wifi_sockets,
    ensure_wifi_tls_identity,
    wifi_enabled,
    wifi_bind_addresses,
    wifi_port,
    wifi_tls_context,
)

logger = logging.getLogger(__name__)
WIFI_INTERFACE_POLL_SECONDS = 5


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


def _wifi_listener_needs_restart(
    current_addresses: Sequence[str],
    desired_addresses: Sequence[str],
    server_running: bool,
) -> bool:
    return set(current_addresses) != set(desired_addresses) or not server_running


def _bind_wifi_listener(port: int) -> tuple[list[socket.socket], list[str], str | None]:
    listener_error = None
    try:
        sockets = bind_wifi_sockets(port)
    except OSError as error:
        listener_error = (
            "PocketDeck could not bind authenticated Wi-Fi to the private "
            f"network on TCP port {port}: {error}. Close other apps using "
            "that port and allow PocketDeck on Private networks only in "
            "Windows Defender Firewall."
        )
        logger.exception("PocketDeck could not bind its private Wi-Fi addresses.")
        sockets = bind_wifi_sockets(port, include_lan=False)

    addresses = [
        str(listener.getsockname()[0])
        for listener in sockets
        if listener.getsockname()[0] != "127.0.0.1"
    ]
    if wifi_enabled() and not addresses and listener_error is None:
        listener_error = (
            "No private LAN IPv4 address is available. Connect this PC to a "
            "private network. USB reverse remains available on loopback."
        )
    return sockets, addresses, listener_error


def _start_wifi_server(
    identity: WifiTlsIdentity,
    port: int,
    sockets: list[socket.socket],
) -> tuple[uvicorn.Server, threading.Thread]:
    wifi_config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        lifespan="off",
        reload=False,
    )
    wifi_config.load()
    wifi_config.ssl = wifi_tls_context(identity)
    server = uvicorn.Server(wifi_config)
    thread = threading.Thread(
        target=_run_wifi_server,
        args=(server, sockets, port),
        daemon=True,
        name="PocketDeck-WiFi-Listener",
    )
    thread.start()
    return server, thread


def _monitor_wifi_listener(
    stop: threading.Event,
    identity: WifiTlsIdentity,
    port: int,
) -> None:
    while not stop.wait(WIFI_INTERFACE_POLL_SECONDS):
        try:
            desired_addresses = [
                address
                for address in wifi_bind_addresses()
                if address != "127.0.0.1"
            ]
        except OSError:
            logger.exception("PocketDeck could not inspect private Wi-Fi addresses.")
            continue

        current_addresses = getattr(app.state, "wifi_addresses", [])
        server = getattr(app.state, "wifi_server", None)
        thread = getattr(app.state, "wifi_thread", None)
        server_running = (
            server is not None
            and thread is not None
            and thread.is_alive()
            and server.started
            and not server.should_exit
        )
        if not _wifi_listener_needs_restart(
            current_addresses,
            desired_addresses,
            server_running,
        ):
            continue

        restart_reason = (
            "private_addresses_changed"
            if set(current_addresses) != set(desired_addresses)
            else "listener_stopped"
        )
        logger.info(
            "Refreshing authenticated Wi-Fi listener reason=%s old_address_count=%s "
            "new_address_count=%s.",
            restart_reason,
            len(current_addresses),
            len(desired_addresses),
        )
        if server is not None:
            server.should_exit = True
        if thread is not None:
            thread.join(timeout=10)
            if thread.is_alive():
                logger.error("Authenticated Wi-Fi listener did not stop for refresh.")
                continue

        app.state.wifi_server = None
        app.state.wifi_thread = None
        app.state.wifi_addresses = []
        app.state.wifi_error = (
            "The authenticated Wi-Fi listener is refreshing after a network change."
        )
        sockets: list[socket.socket] = []
        try:
            sockets, addresses, listener_error = _bind_wifi_listener(port)
            server, thread = _start_wifi_server(identity, port, sockets)
        except (OSError, RuntimeError, ValueError):
            for listener in sockets:
                listener.close()
            app.state.wifi_error = (
                "The authenticated Windows connection listener could not restart. "
                "Check the private Wi-Fi network, certificate, and TCP port permissions."
            )
            logger.exception("PocketDeck authenticated Wi-Fi listener refresh failed.")
            continue

        app.state.wifi_addresses = addresses
        app.state.wifi_error = listener_error
        app.state.wifi_server = server
        app.state.wifi_thread = thread
        logger.info(
            "Authenticated Wi-Fi listener refresh started port=%s private_address_count=%s "
            "error_present=%s.",
            port,
            len(addresses),
            listener_error is not None,
        )


if __name__ == "__main__":
    wifi_server = None
    wifi_thread = None
    wifi_sockets: list[socket.socket] = []
    wifi_monitor_stop = threading.Event()
    wifi_monitor_thread = None
    app.state.wifi_error = None
    app.state.wifi_server = None
    app.state.wifi_thread = None
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
        wifi_sockets, app.state.wifi_addresses, app.state.wifi_error = (
            _bind_wifi_listener(port)
        )
        wifi_server, wifi_thread = _start_wifi_server(
            identity,
            port,
            wifi_sockets,
        )
        app.state.wifi_server = wifi_server
        app.state.wifi_thread = wifi_thread
        logger.info(
            "PocketDeck Wi-Fi listener startup completed port=%s "
            "private_address_count=%s enabled=%s.",
            port,
            len(app.state.wifi_addresses),
            wifi_enabled(),
        )
        if wifi_enabled():
            wifi_monitor_thread = threading.Thread(
                target=_monitor_wifi_listener,
                args=(wifi_monitor_stop, identity, port),
                daemon=True,
                name="PocketDeck-WiFi-Monitor",
            )
            wifi_monitor_thread.start()
    except (OSError, RuntimeError, ValueError):
        app.state.wifi_error = (
            "The authenticated Windows connection listener could not start. "
            "Check PocketDeck's Wi-Fi certificate and TCP port permissions."
        )
        logger.exception("PocketDeck secure connection listener startup failed.")
        for listener in wifi_sockets:
            listener.close()
    try:
        logger.info("PocketDeck local backend startup completed.")
        uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)
    finally:
        logger.info("PocketDeck backend shutdown requested.")
        wifi_monitor_stop.set()
        if wifi_monitor_thread is not None:
            wifi_monitor_thread.join(timeout=10)
        wifi_server = getattr(app.state, "wifi_server", wifi_server)
        wifi_thread = getattr(app.state, "wifi_thread", wifi_thread)
        if wifi_server is not None:
            wifi_server.should_exit = True
        if wifi_thread is not None:
            wifi_thread.join(timeout=10)
        logger.info("PocketDeck backend shutdown completed.")
