# PocketDeck Architecture

> **Status:** This document describes a proposed architecture for a clean-start
> repository. The components and workflows below are plans, not claims about
> implemented or working software. Items marked **Future** are explicitly
> deferred.

## Goals and boundaries

PocketDeck is intended to let a user control approved actions on a Windows PC
from connected devices. Keep the first implementation small: establish a
versioned protocol, implement a narrow set of safe actions, and add clients and
transports in milestones.

Windows is authoritative. It owns the shared configuration and executes PC
actions. Connected clients request changes or actions; they do not become
independent sources of truth and must never receive unrestricted shell access.

## Component overview

| Component | Responsibility | Initial status |
| --- | --- | --- |
| **PocketDeck Desktop** | Windows desktop application built with Tauri, React, and Vite. Provides the local user interface and packages or starts the local backend as the implementation is decided. | Planned; not implemented |
| **Python backend** | FastAPI service responsible for managing connected devices, validating requests, maintaining shared configuration, and executing approved PC actions. | Planned; not implemented |
| **Action registry** | Central, allowlisted set of supported actions. Each action defines its input validation and execution behavior. | Planned; not implemented |
| **Shared configuration** | Versioned JSON data for buttons, layouts, profiles, pages, and actions. Windows owns the authoritative copy. | Planned; not implemented |
| **Connected clients** | Initially, mobile clients connect over Wi-Fi and use the shared protocol to read configuration and request approved actions. | Future; not implemented |
| **Other clients** | Android, iOS, and web clients are intended to use the same shared protocol. | Future; not implemented |
| **PocketDeck OS** | Deferred Linux-based client/device concept. It must use the same shared protocol. USB-C serial is a possible future transport, subject to hardware compatibility. | Deferred future; not implemented |

### Proposed module boundaries

- **Desktop shell and UI:** Tauri owns the Windows desktop application boundary;
  React components implement the UI, and Vite supports the frontend
  development/build workflow.
- **Backend API:** FastAPI handles REST management requests and WebSocket
  connections. Keep transport handling separate from business rules.
- **Domain services:** Configuration validation and revision tracking, device
  management, pairing authorization, and action dispatch should be distinct
  responsibilities.
- **Action registry:** Action definitions and their validation live behind a
  narrow dispatch interface. The API accepts action identifiers and
  schema-validated arguments, not arbitrary commands.
- **Protocol and schema:** Versioned JSON definitions describe the data and
  messages shared by the Windows host and every client. Clients should not
  need Windows-specific action execution logic.

These are proposed boundaries, not a prescription to create every module at
once. Start with the smallest useful set and split modules when a boundary
improves clarity or testability.

## Shared configuration and protocol

Define a versioned JSON schema for:

- **Buttons** and their presentation and assigned action.
- **Layouts** and how buttons are arranged.
- **Profiles** and their associated layouts or settings.
- **Pages** and navigation between groups of controls.
- **Actions** and their identifiers and validated parameters.

The schema should state required fields, allowed values, and compatibility
rules. Validate configuration when it is loaded and before accepting an
update. Include a schema or protocol version so clients can detect incompatible
data and handle unsupported versions explicitly.

Windows owns the authoritative configuration. Clients may request edits, but
the backend validates and applies them. Track a monotonically increasing
revision for accepted configuration changes. Clients can compare revisions
after reconnecting and request the latest state; stale updates should be
detected rather than silently overwriting newer state.

The same protocol should work for future Android, iOS, web, and PocketDeck OS
clients. Do not make transport-specific details part of the shared
configuration format.

## Communication flow

Use **REST APIs** for management and **WebSockets** for real-time updates.
The initial intended mobile transport is Wi-Fi. USB-C serial is a **future**
option for PocketDeck OS only, contingent on compatible hardware and a defined
transport implementation.

1. The desktop starts or connects to the local FastAPI backend.
2. A device discovers or is given the Windows host address, then pairs with
   authorization from the Windows user.
3. After authentication, the client uses REST to retrieve configuration,
   inspect permitted capabilities, and submit management requests.
4. The client opens an authenticated WebSocket to receive configuration
   revision changes, connection-state updates, and action results.
5. To run an action, the client sends an action identifier and arguments. The
   backend validates the request, checks that the device is authorized, and
   dispatches only through the action registry.
6. Windows executes the approved action and reports a result. The backend logs
   the outcome and sends a real-time update when appropriate.
7. On disconnect, the client reconnects, reauthenticates, and reconciles its
   configuration using the current revision.

REST and WebSocket operations should share the same authorization rules and
domain services. A WebSocket connection is not itself proof of permission to
change configuration or execute an action.

## Security boundaries

- **No unrestricted shell execution:** Never expose a shell, command string,
  or arbitrary process-launch API to connected clients. Action execution must
  go through a central allowlist of explicitly supported operations.
- **Validate at the host:** Treat all client messages and stored/imported
  configuration as untrusted. Validate message shape, schema version, action
  identifier, and action arguments in the backend before applying them.
- **Authenticate devices:** Require device authentication for REST and
  WebSocket access. Do not treat possession of the host address or an open
  connection as authentication.
- **Authorize pairing:** Pairing requires explicit authorization by the
  Windows user. Provide a way to revoke a paired device; enforce authorization
  again when a device reconnects.
- **Limit capabilities:** Give each operation only the authority it needs.
  Clients request actions; only the Windows backend executes them.
- **Keep useful logs:** Record pairing and revocation, configuration
  revisions, action identifiers, request outcomes, and errors. Avoid logging
  secrets or unnecessarily sensitive user data.
- **Make failures explicit:** Reject invalid, unsupported, or unauthorized
  requests with clear errors. Do not report success when validation or action
  execution failed.

Authentication credentials, key storage, network exposure, and the exact
pairing UX still need concrete designs before implementation. They must be
decided and tested before relying on the service outside a trusted development
setup.

## Reliability and testing

Plan for device authentication, pairing authorization, configuration revision
tracking, reconnect handling, validation, logging, and tests from the start.
For reconnects, restore authenticated state only through the defined
authentication flow, then reconcile revisions; do not assume missed real-time
events were received.

Test the shared schema and validation, API authorization, action-registry
allowlisting, revision conflicts, device disconnect/reconnect behavior, and
WebSocket event delivery. Keep action execution behind a boundary that can be
tested without triggering real PC actions. Add focused tests with each
milestone rather than postponing testing until the system is integrated.

## Proposed repository structure

The following is a **proposal**, not a description of existing files:

```text
Pocketdeck/
  docs/
    architecture.md
  apps/
    desktop/                 # Planned: Tauri + React + Vite Windows app
  backend/
    app/
      api/                    # Planned: FastAPI REST and WebSocket endpoints
      devices/                # Planned: device and pairing management
      config/                 # Planned: shared configuration and revisions
      actions/                # Planned: action registry and dispatch
      protocol/               # Planned: message and schema validation
    tests/                    # Planned: focused backend and protocol tests
  shared/
    schemas/                  # Planned: versioned JSON configuration schemas
```

Create folders as their milestone begins; do not add placeholder modules just
to match this tree. Keep UI code, backend responsibilities, and shared protocol
definitions separate, and document any deliberate change to this proposal.

## Implementation milestones

Each milestone should be small enough to run and test locally before starting
the next one. Avoid unnecessary dependencies; use the chosen frameworks and
standard libraries where they meet the need.

1. **Agree on the protocol shape:** Draft the versioned JSON schema for
   buttons, layouts, profiles, pages, and actions. Add examples and validation
   tests. Do not execute PC actions yet.
2. **Build the local Windows shell:** Establish the Tauri, React, and Vite
   desktop development workflow and a basic UI. Keep it independent of remote
   clients.
3. **Add the backend foundation:** Introduce FastAPI with health and
   management endpoints, configuration validation, and focused tests. Decide
   how the desktop starts and supervises the backend before depending on it.
4. **Add safe action dispatch:** Implement a small action registry with a
   minimal set of explicitly approved actions. Test argument validation,
   authorization, rejection of unknown actions, and failure reporting.
5. **Add authenticated device pairing:** Define the pairing UX, credential
   handling, authorization, and revocation. Test denied and revoked devices
   as well as successful pairing.
6. **Add real-time updates and recovery:** Introduce authenticated WebSockets,
   configuration revisions, action results, disconnect handling, and
   reconnect reconciliation. Test missed updates and stale revisions.
7. **Add the first mobile client over Wi-Fi:** Use the shared protocol rather
   than adding a client-specific backend. Keep **Android and iOS future work**
   until selected and implemented.
8. **Evaluate additional clients and transports:** A **web client** and
   **PocketDeck OS** are future work. Consider USB-C serial for PocketDeck OS
   only after confirming hardware compatibility and specifying how it carries
   the shared protocol.

At each step, preserve clear module boundaries, run focused tests, and record
unfinished decisions rather than treating proposed behavior as implemented.
