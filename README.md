# PocketDeck

PocketDeck is a Windows Tauri desktop client with a shared React browser
client and a FastAPI backend. It provides revision-aware profile/page and
button configuration, allowlisted action execution, device pairing, and
authenticated local WebSocket updates. The backend is loopback-only; remote
and LAN deployment are not supported.

## Project folders

- [`frontend/`](./frontend/README.md) — shared React/Vite client, Windows
  Tauri shell, browser workflow, and Windows packaging.
- [`backend/`](./backend/README.md) — FastAPI service, configuration storage,
  action registry/execution, and device authorization.
- [`shared/`](./shared/README.md) — versioned configuration and protocol
  schemas/examples.
- [`docs/`](./docs/development.md) — development, browser, test, and security
  guidance.
- [`tests/`](./tests/README.md) — cross-project test organization.

See [the architecture](./docs/architecture.md) for component boundaries and
security limitations.
