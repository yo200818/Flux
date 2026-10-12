# PocketDeck Backend

The Python FastAPI service provides the persisted versioned configuration,
allowlisted action execution, pairing/device authorization, and authenticated
WebSocket revision notifications. It binds to `127.0.0.1` by default and must
not be exposed to a LAN or public network.

See [`../docs/development.md`](../docs/development.md) for the virtual
environment, development, browser-client, packaging, security, and test
instructions.
