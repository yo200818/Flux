# PocketDeck Architecture Decisions

**Status:** Phase 1 decisions finalized for the next protocol generation.
These decisions specify a target contract; they do not claim that an Android
client, Wi-Fi mobile transport, USB transport, or protocol-v2 server is
implemented.

## Product boundary

- **Android is the deck runtime.** It owns an atomic, persistent local copy of
  the last accepted configuration. It restores that copy after process restart
  and resolves a button press against its local configuration without a
  per-press configuration request.
- **Windows is the studio and privileged executor.** The Windows application
  edits and publishes configurations, pairs/revokes devices, validates
  incoming Windows-targeted action requests, and executes only registered,
  explicitly permitted Windows actions.
- **A button references a configuration action by stable `action_id`.** Its
  action declares a transport-independent target (`android_local` or
  `windows_host`), type, and validated parameters. Android runs local actions
  itself and sends a self-contained, authenticated request for a
  Windows-targeted action.
- **Configuration distribution is separate from action execution.** Windows
  sends a complete snapshot at setup/recovery and publishes accepted edits.
  A client can apply a contiguous incremental update or request a snapshot.
  Windows does not need to answer an Android configuration lookup for each
  button press.
- **Wi-Fi and USB-C are transports, not data models.** Both carry the same
  versioned message envelopes and configuration/action meanings. Network,
  serial-port, USB-role, and discovery details do not belong in configuration
  objects.
- **The web UI is out of scope for this phase.** Existing browser behavior is
  not a new target for the mobile protocol.

## Components and responsibility recommendation

| Component | Decision |
| --- | --- |
| Windows Tauri studio | Retain. It is the local user interface, process owner, and trusted configuration editor. |
| FastAPI backend | Retain for now as a separately testable local service and boundary around persisted configuration, pairing/device registry, and the existing action registry. Do not replace or remove it in Phase 1. |
| Windows executor | Keep behind the backend/action-registry boundary. The Tauri-owned backend process is currently the executor for its supported action. A later implementation may move this boundary into the Windows host, but only with equivalent authentication, registry validation, lifecycle ownership, and contract tests. |
| Android runtime | New future client. Persist and interpret configuration locally; do not call the Windows configuration API to resolve every press. |
| Shared contracts | `shared/schemas/v1` is the deployed legacy contract; `shared/schemas/v2` is the target contract finalized here. Protocol and configuration versions are independent. |
| Transports | Wi-Fi WebSocket is the first target transport. USB-C serial is an investigated, unresolved option and is not declared supported. |

FastAPI should not be embedded into the Tauri process or replaced in this
phase. Existing storage, revision checks, pairing, and action execution are
working integration points. The service currently binds to loopback, while
mobile Wi-Fi requires a deliberate later networking/security deployment
design; the current server is not a LAN service.

## Source-of-truth and storage

Windows owns the published configuration and its monotonically increasing
revision. A configuration revision is a non-negative integer scoped to a
server-generated `config_epoch` UUID. Windows persists both with the accepted
configuration. It must not silently reset or reuse a revision within an epoch.
If revision continuity is lost, it creates a new epoch and requires a full
snapshot; a client must not apply deltas from another epoch.

Android stores the accepted configuration, epoch, revision, and integrity
metadata in app-private persistent storage. It validates every snapshot/delta,
applies an update to a candidate copy, writes and atomically commits it, then
updates in-memory state and acknowledges the committed revision. A failed
write leaves the previous saved and active configuration intact. Process
restart restores the last committed copy. UI-only state such as selected
profile/page is local and is not added to the shared configuration.

The current FastAPI store persists its configuration and integer revision on
Windows. It does not yet implement `config_epoch`, Android persistence, or
protocol-v2 snapshot/delta delivery. Those are implementation blockers for
mobile synchronization, not reasons to change the working v1 endpoint in this
architecture-only phase.

## Configuration and actions

The target configuration contract is
[`../shared/schemas/v2/config.schema.json`](../shared/schemas/v2/config.schema.json)
with a representative document at
[`../shared/examples/config.v2.json`](../shared/examples/config.v2.json).
It retains stable deck identity, profiles, pages, ordered buttons,
presentation fields, globally unique stable IDs, and validated action
parameters. Empty profiles/pages/action lists can represent an initial or
temporarily empty deck. V2 makes the action target explicit and keeps
transport data out of the document. The Android UI remains free to choose how
it presents profile/page selection and button color/icons.

Buttons carry only an `action_id`; clients resolve it against the configuration
they already have. A local action (`android_local`) runs on Android only after
the client validates the referenced action and parameters. A remote action
(`windows_host`) is sent with its action descriptor, button ID, source
configuration revision, and unique request ID. The descriptor makes the
request self-contained; it is not permission to execute.

Before dispatch, Windows must authenticate the device, require a current
published configuration revision, resolve the action in its in-memory
published-action catalogue, require that the button/action association and
parameters match that revision, validate target/type/parameters through the
Windows action registry, apply Windows-owned execution policy, and deduplicate
the request ID. The caller's `enabled_for_execution` value is not a security
decision. Do not accept arbitrary process names, shell strings, scripts, URLs
without registry validation, or client-supplied policy.

The existing v1 backend resolves an action ID from its current configuration
for every `/api/actions/{id}/execute` call. It dispatches `open_url` and,
on Windows, an allowlisted `keyboard_shortcut` through `SendInput` to the
active foreground window. That API authenticates the caller and validates the
stored action, but is not the v2 mobile command; v2 must not degrade to a
button-press-time Android configuration fetch. A bounded idempotency ledger is
required for v2 Windows actions; after a crash, a recorded in-progress request
is reported as outcome-unknown rather than automatically executed a second
time.

## Protocol, synchronization, and transport

The target wire contract is
[`protocol-v2.md`](./protocol-v2.md), with machine-readable envelope schema
[`../shared/schemas/v2/protocol.schema.json`](../shared/schemas/v2/protocol.schema.json).
It specifies negotiation, pairing/authenticated connection, configuration
sync and publish, acknowledgements, actions, structured errors, reconnect,
and revision handling. Protocol version 2 and configuration schema version 2
are negotiated independently.

The transport interface delivers bounded complete UTF-8 JSON messages and
reports connection state. A transport is responsible for discovery/connect,
framing, byte delivery, and close/error notification; protocol handlers own
version negotiation, authorization context, message validation, sync,
acknowledgements, and actions. Wi-Fi WebSocket frames already provide message
boundaries. The proposed USB byte stream uses a 4-byte big-endian length
prefix followed by one UTF-8 JSON message; the prefix is transport framing,
not a protocol field.

The USB investigation, device-role constraints, evidence sources, and
unresolved questions are in
[`usb-c-feasibility.md`](./usb-c-feasibility.md). A USB-C connector alone does
not imply a compatible serial/device role or a working application channel.

## Pairing and security

The current Windows API pairs through a short-lived one-use code, explicit
administrator approval, a generated device bearer credential, and revocation.
The device registry stores a SHA-256 digest, not plaintext device credentials.
The current packaged Windows app generates its administrator token at runtime;
development requires a private shared environment token. These existing
behaviors are described in [`development.md`](./development.md).

The target Android client stores its device credential encrypted with an
Android Keystore-protected key in app-private storage, excludes it from
backup/export, and clears it on logout/re-pair. The Windows device registry
stores only a verifier for high-entropy bearer tokens; administrative secrets
remain separate from device credentials. A lost or revoked credential is
rejected on new HTTP/WebSocket/USB authentication. Active sessions are closed
when practical; offline clients learn of revocation when they reconnect.

For Wi-Fi, the mobile deployment must use authenticated encrypted transport
(WSS) and a deliberate certificate/trust strategy. Current loopback `ws://`
and HTTP behavior is development/desktop-only and does not meet this remote
transport requirement. USB authentication must be cryptographically
authenticated even when physically attached; physical access is not
authorization. The USB credential-protection/handshake design is unresolved
and blocks declaring USB support.

Never weaken the existing restrictive Tauri CSP, loopback binding, action
registry, or device authorization to make a transport work. No unrestricted
shell or arbitrary command execution is permitted.

## Compatibility and migration

V1 remains the current Windows runtime schema and current desktop WebSocket
contract. V2 is additive and is not accepted by the present backend. Do not
silently reinterpret a v1 document as v2 or send v2 fields to the v1 PUT API.

Before rollout, implement and test an explicit v1-to-v2 migration:

1. Keep the existing `%APPDATA%\PocketDeck\configuration.json` (or
   `POCKETDECK_CONFIG_PATH`) strictly v1 until a deliberate migration UI and
   v2 runtime exist. The current loader validates as v1; invalid/unreadable
   saved files cause startup failure and remain unchanged. No automatic
   conversion is implemented.
2. Preserve the original document and all profile/page/button/action IDs and
   order; write a backup and use atomic replacement.
3. Add one stable `deck.id`; add `target: "windows_host"` to each legacy
   action because v1 does not encode a target and the v1 executor runs actions
   on Windows. This is a conservative mapping; local Android actions are new
   explicit v2 data, never inferred from a legacy action name.
4. Preserve labels, icon/color appearance fields, enablement, and parameters.
   Validate the complete v2 result, references, IDs, action target/parameter
   rules, and grid capacity before publishing it.
5. Assign a new protocol/configuration epoch where needed and publish a full
   snapshot. If migration or validation fails, keep the original v1 data
   untouched and report a recoverable error.
6. Keep legacy desktop v1 clients and APIs working until a separately planned
   compatibility window ends.

Do not begin Android UI implementation until the v2 schemas/specification pass
contract validation and the blockers below have owners and decisions.

## Current discrepancies and blockers

| Target decision | Current implementation | Required later work |
| --- | --- | --- |
| Android owns a durable local configuration and resolves button presses locally. | No Android project/client exists; backend owns the only persisted configuration. | Implement an Android repository/cache and restart-safe atomic persistence. |
| A published snapshot/delta protocol carries configuration and revisions. | `GET/PUT /api/config` handles complete documents; current WebSocket only accepts `client.ping` and emits revision notifications. | Add v2 negotiation, sync, full snapshot, contiguous deltas, acknowledgements, and recovery. |
| Every action declares local-vs-Windows target. | V1 actions have `id`, `type`, parameters, and enablement but no target. | Migrate v1 to v2 and add target-aware validation on both sides. |
| Android resolves actions locally; Windows validates a self-contained Windows request. | Existing action API accepts only action ID and reads the configuration for each request. | Implement the v2 request and cached published-action catalogue, registry/policy validation, and deduplication. |
| Wi-Fi clients use protected transport. | FastAPI/Tauri currently use loopback HTTP/WS; no TLS/mobile LAN endpoint is configured. | Design and test WSS, address discovery, certificate/trust and firewall behavior without opening LAN access prematurely. |
| USB-C is a transport alternative. | No serial API/driver/USB role support is implemented or hardware-tested. | Resolve Android/Windows roles, supported hardware, Windows serial access, authentication, and framing on actual devices. |
| Config IDs/revisions are epoch-scoped. | Current Windows config store persists integer revision only. | Add a backward-compatible persisted epoch and migration/recovery rules. |
| Pairing/revocation and session auth work across clients. | Existing FastAPI foundation supports device credentials and WebSocket authorization; no Android pairing UI/storage exists. | Define and test mobile enrollment, protected credential storage, active revocation, and protocol negotiation. |

## Validation policy

The v2 schema is transport-independent and self-contained; the protocol
specification is authoritative for message sequencing and persistence
acknowledgements. Contract tests must check that the representative v2 example,
schema fields, action-target rules, messages, and legacy v1 sample remain
consistent. Existing backend/frontend integration tests continue to validate
the v1 runtime until v2 is implemented. Contract/spec tests do not prove
Android persistence, remote WSS security, USB compatibility, or action
execution on Android.
