# PocketDeck Protocol v2

**Status:** Phase 1 has an opt-in Windows TLS WebSocket runtime and an Android
client for pairing, initial/full snapshot synchronization, reconnects, and
Windows-hosted action execution. The loopback HTTP API and v1 WebSocket remain
available for the desktop UI; the separate LAN listener accepts only TLS.
Protocol v2 is independent of configuration schema v2. This unreleased
contract may be extended without changing the v1 runtime; deployed protocol
versions require an explicit compatibility policy.
Machine-readable envelope contract:
[`../shared/schemas/v2/protocol.schema.json`](../shared/schemas/v2/protocol.schema.json).
Configuration contract:
[`../shared/schemas/v2/config.schema.json`](../shared/schemas/v2/config.schema.json).

## 1. Envelope and limits

Every message is one UTF-8 JSON object with:

| Field | Required | Meaning |
| --- | --- | --- |
| `protocol_version` | yes | Integer `2`; no silent downgrade. |
| `message_id` | yes | UUID generated for this message. For `action.execute`, this UUID is also its idempotency key. |
| `type` | yes | Message name from the v2 allowlist. |
| `payload` | yes | Object with the fields specified below. |
| `in_reply_to` | response only | UUID `message_id` of the request being answered. |

Unknown envelope fields and message types are rejected. Configuration
snapshots and deltas are at most 4 MiB serialized UTF-8; all other messages
are at most 16 KiB. Enforce the limit before JSON parsing and also enforce
schema/entity limits after parsing. A size violation returns `message_too_large`
when the peer can still be safely addressed, then closes the connection.

Use exact JSON types (no string-to-number coercion), safe non-negative
integers no greater than $2^{53}-1$ for revisions and sequence numbers, UUIDs
for epoch/device/session/message IDs, and
UTF-8. Configuration must pass the v2 schema plus semantic validation:
globally unique IDs; every button's action exists; grid capacity is sufficient;
action target/type combinations and parameters are valid; and the entire
encoded document is within the byte limit. URLs are HTTP(S) only. Unknown
action types, additional action parameter fields, shell strings, executable
paths, and scripts are rejected.

Example request:

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000001",
  "type": "client.hello",
  "payload": {
    "device_id": "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
    "supported_protocol_versions": [2],
    "supported_configuration_versions": [2]
  }
}
```

## 2. Pairing bootstrap, authentication, and version negotiation

Pairing is the only unauthenticated application flow. The Windows studio creates a six-digit numeric, short-lived, single-use
pairing PIN using a cryptographically secure random generator after explicit
user action. Android obtains the TLS certificate fingerprint and companion
identity by scanning the Windows connection QR code, then presents the PIN in `pairing.claim` with a
device name and supported versions. The server rate-limits claims, consumes a
valid code once, binds a new device identity, and returns `pairing.pending`.
This pending identity has no configuration or action privileges. The Windows
user reviews the device and explicitly approves or rejects it. Approval sends
`pairing.approved` once over the same protected channel, carrying a
high-entropy device credential; rejection/expiry returns a stable pairing
error. `pairing.status` returns `pairing.status.result` with only
`pending`/`approved`/`rejected`/`expired`; it must never return a credential.

For ADB-reverse USB transport, Android sends an empty PIN only when the
connection reaches the Windows loopback listener and the claim is explicitly
marked `transport: "usb"`. The request still enters the same pending queue and
requires explicit Windows approval before a device credential is issued.
USB transport does not bypass the pinned TLS channel or device authorization.
This transport depends on Android USB debugging, an authorized ADB host, a
data-capable cable, and a PocketDeck reverse mapping; it has not been hardware
validated.

The pairing credential is shown/transmitted only once, stored by Android in
encrypted app-private storage backed by Android Keystore, and stored by
Windows as a verifier (not plaintext). It is excluded from backups and logs.
Use TLS for Wi-Fi pairing as well as normal sessions; do not treat physical
USB access as authentication. USB pairing remains disabled until a separately
authorized transport is implemented and validated.
Revoke credentials by device ID, invalidate active sessions, and require a
new explicit approval to pair again. A credential with no expiry remains
revocable; a deployment should prefer bounded credential lifetimes if it can
support safe renewal.

On Windows, LAN Wi-Fi is disabled unless `POCKETDECK_ENABLE_WIFI=1` is set
before launching PocketDeck. The TLS listener binds to all interfaces on port
8443 by default (`POCKETDECK_WIFI_PORT` can select another port); use Windows
Firewall/network controls to restrict access to trusted private networks.
The self-signed certificate private key is protected with Windows DPAPI. The
Windows Devices section displays a QR code containing the companion ID,
available host addresses, port, and SHA-256 certificate fingerprint. Android
pins that exact certificate and checks the companion ID in `server.welcome`;
the PIN is not used as TLS trust. Android does not trust public certificate
authorities for this connection and does not fall back to plaintext.

Only the pairing claim/status messages are accepted before authentication.
After approval, a fresh authenticated transport session is required before
`client.hello`, synchronization, or actions. The server validates the
transport-authenticated device identity on every session; an envelope field
cannot assert a role or bypass revocation.

Authentication is established by the transport adapter before accepting
normal application messages. The transport exposes the authenticated device
identity and role to the protocol handler; `device_id` in `client.hello` must
match it. The payload cannot assert or elevate a role.

For Wi-Fi, use authenticated TLS (`wss://`) and a paired bearer credential
bound to the authorized device. A WebSocket client offers the `pocketdeck.v2`
subprotocol and an authorization credential through the protected transport
handshake; the server selects only `pocketdeck.v2`. Do not put secrets in a
URL, logs, or configuration. The current desktop's `pocketdeck.v1` subprotocol
is legacy and is not compatible with these messages.

For USB, use a transport-specific authenticated channel handshake that
establishes the same authenticated device identity before `client.hello`.
The concrete USB credential proof and at-rest verifier scheme is **unresolved**
and must be designed before USB can be enabled; accepting a physical cable as
authentication is forbidden.

The client sends its supported protocol and configuration versions in
`client.hello`. The server selects the highest mutually supported protocol and
configuration version it implements, and returns them in `server.welcome`.
Protocol v2 currently selects configuration schema v2. If there is no common
version, send `protocol.error` with `unsupported_protocol` or
`unsupported_configuration`, then close without sending configuration or
executing actions. Do not guess, coerce, or silently downgrade a document.

Successful handshake:

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000002",
  "type": "server.welcome",
  "in_reply_to": "00000000-0000-4000-8000-000000000001",
  "payload": {
    "session_id": "fc6cd066-874d-4f15-a77a-1ba95662ccaf",
    "server_id": "3f5067d0-6e85-49b7-9cef-64476fdb3473",
    "selected_protocol_version": 2,
    "selected_configuration_version": 2,
    "head": {
      "config_epoch": "8aa8ce90-35fa-4ab2-9c49-5d4732cb3267",
      "revision": 12
    }
  }
}
```

`server_id` is stable for the Windows installation. `config_epoch` is stable
while revision history is continuous. Neither belongs inside the configuration
document.

## 3. Snapshot, delta, persistence, and publication

After `server.welcome`, the client sends `config.sync` containing either
`last_accepted: null` or its persisted `{config_epoch, revision}`:

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000003",
  "type": "config.sync",
  "payload": {
    "last_accepted": {
      "config_epoch": "8aa8ce90-35fa-4ab2-9c49-5d4732cb3267",
      "revision": 11
    }
  }
}
```

`config.sync` is the only authoritative client revision claim; `client.hello`
contains supported versions and the authenticated device identity, not another
copy of `last_accepted`. The client may set `force_snapshot: true` when local
state is corrupt or it has explicitly requested recovery. A configuration
version mismatch fails closed with `unsupported_configuration`.

The server responds with a full `config.snapshot` when the client has no
configuration, its epoch differs, its revision is ahead/unknown, the delta
history is unavailable, or the client requests recovery. Otherwise it sends
each missing contiguous `config.delta` in order. The server sends a snapshot
at first setup. Accepted Windows studio edits are published to connected
clients as a delta when the base is known, and queued/reconciled on reconnect.

The current Phase 1 backend does not retain a delta history, so it deliberately
sends a complete, validated snapshot at first synchronization and after a
revision change. It does not accept client configuration writes. Android
atomically replaces its local cache with accepted Windows snapshots and keeps
that cache visible while disconnected.

Snapshot example (the abbreviated configuration here is illustrative; a real
message contains the complete schema-valid document):

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000004",
  "type": "config.snapshot",
  "in_reply_to": "00000000-0000-4000-8000-000000000003",
  "payload": {
    "config_epoch": "8aa8ce90-35fa-4ab2-9c49-5d4732cb3267",
    "revision": 12,
    "configuration": {
      "schema_version": 2,
      "deck": {
        "id": "pocketdeck-main",
        "name": "PocketDeck"
      },
      "profiles": [
        {
          "id": "default",
          "name": "Default",
          "pages": [
            {
              "id": "main",
              "name": "Main",
              "grid": { "columns": 1, "rows": 1 },
              "buttons": []
            }
          ]
        }
      ],
      "actions": [
        {
          "id": "open-local",
          "target": "android_local",
          "type": "open_url",
          "enabled_for_execution": true,
          "parameters": { "url": "https://example.com/" }
        }
      ]
    }
  }
}
```

A delta has `base_revision`, `revision`, and an ordered `operations` array.
`revision` must equal `base_revision + 1`. Operations use only this closed
vocabulary:

| Operation | Effect |
| --- | --- |
| `deck.replace` | Replace the deck name/identity object. The deck ID must remain stable for this deck. |
| `profile.upsert` / `profile.remove` | Insert or replace a profile at an explicit array index, or remove by ID. |
| `page.upsert` / `page.remove` | Insert or replace a page at an explicit index within a profile, or remove by profile/page ID. |
| `button.upsert` / `button.remove` | Insert or replace a button at an explicit index within a page, or remove by full parent IDs and button ID. |
| `action.upsert` / `action.remove` | Insert or replace an action at an explicit array index, or remove by ID. |
| `command.upsert` / `command.remove` | Insert or replace a saved command at an explicit index, or remove by ID. `run_command` parameters continue to reference a saved command ID. |
| `shortcut.upsert` / `shortcut.remove` | Insert or replace a saved shortcut at an explicit index, or remove by ID. |
| `settings.replace` | Replace the complete v2 settings object. |

Unknown operation names/fields, malformed indices, missing parents, duplicate
IDs, and dangling references reject the complete delta. Apply operations in
array order to a candidate copy, validate the resulting complete v2
configuration, then commit atomically. Never apply operations to a different
epoch or base revision. A gap, invalid operation/result, or unsupported schema
causes `snapshot_required`/`invalid_configuration`; retain the previously
persisted snapshot. Protocol code does not accept arbitrary JSON Pointer or
generic patch paths.

The Android runtime writes a temporary app-private file, flushes it, and
atomically replaces its last accepted file. Only after durable commit does it
replace active in-memory configuration and send `message.ack` with stage
`configuration.persisted`, `config_epoch`, and `revision`. On a storage error,
keep the prior state, send `configuration_persistence_failed`, and do not
acknowledge the new revision. The same invariant applies to restart recovery:
load and validate the last committed snapshot before exposing it to the UI.

The Windows server increments the revision only after its persisted
configuration is accepted. A new epoch requires a full snapshot and explicit
reconciliation; clients never compare revisions across epochs. If no change
has occurred, the revision stays the same. A selection-only UI change is not a
configuration update.

## 4. Windows action request and result

Android first resolves the button and action from its local accepted
configuration. For `android_local`, it validates and invokes only an Android
local registry action; no Windows request is made. For `windows_host`, it
sends the action descriptor with the source button and configuration
revision—never a configuration-fetch command:

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000005",
  "type": "action.execute",
  "payload": {
    "button_id": "open-site-button",
    "config_epoch": "8aa8ce90-35fa-4ab2-9c49-5d4732cb3267",
    "config_revision": 12,
    "action": {
      "id": "open-site",
      "target": "windows_host",
      "type": "open_url",
      "parameters": {
        "url": "https://example.com/"
      }
    }
  }
}
```

Windows authenticates the current session and revalidates **every** request:
epoch/revision must be current; the cached published-action catalogue must
contain this Windows-targeted action assigned to this button at that revision;
the supplied action identity and parameters must exactly match that published
entry; its action type and parameters must pass the Windows registry; and
Windows execution policy must permit it. The request's enablement flag and
Android-side checks are not trusted. Unknown, stale, locally targeted,
disabled, malformed, unassigned, or policy-denied actions do not execute.
The catalogue is built when a configuration is published, not fetched from
Android on every press.

Before execution the host durably records the authenticated device plus
`message_id` idempotency key. A repeated key returns the prior accepted/result
state and must not execute again. If a process restart finds an in-progress
record, report outcome unknown and do not auto-execute it again. Retain
deduplication records for at least 24 hours; a longer retention is allowed.
This gives at-most-once dispatch, not a guarantee that the physical side
effect and result delivery are atomic.

For valid requests, the host durably records the authenticated device ID,
original `message_id`, action identity, and accepted state before dispatch. It
returns `message.ack` (`action.accepted`) and later `action.result` correlated
by `in_reply_to`. Outcomes are exactly `succeeded`, `failed`, and `unknown`;
`failed` and `unknown` require a stable bounded `code`. `unknown` is not a
failure and is never permission to replay. A crash/restart with an in-progress
ledger entry is resolved as `unknown` and is not executed again. Duplicate
`action.execute` IDs for the same authenticated device return the stored
accepted/terminal status and never dispatch a second time. Keep records for at
least 24 hours; after expiry return `unknown`/`request_expired`, not a fresh
execution. Reusing the same device-scoped key with a different request body
returns `protocol.error` with `idempotency_conflict` and never executes either
payload again.

The client can send `action.status.query` with the original `request_id` after
reconnecting. The authenticated host returns `action.status.result` with one
of `accepted`, `succeeded`, `failed`, or `unknown`; terminal results may
include action ID, stable code, and bounded message. Unknown or expired IDs
return `unknown` with a code. If the query itself cannot complete, Android
shows an unresolved outcome and does **not** automatically replay the action.
Only a new explicit user press creates a new request ID. UI feedback is not
proof that an operating-system side effect occurred.

`windowsAction` includes `run_command` with only `{command_id}` parameters.
The reference must resolve in the host's published v2 configuration and the
button must be assigned to the action at the requested epoch/revision. Windows
executes the saved, validated, enabled definition through the registered
bounded step types `open_url`, `keyboard_shortcut`, and `wait`, in order.
Nested `run_command`, `system_monitor`, unknown step types, scripts, shell
strings, and client-provided command bodies are forbidden. Android sends the
registered action descriptor/reference only; it never interprets command
steps or executes Windows behavior locally. `android_local` actions never use
`action.execute`.

Current Windows capability is implemented only through the legacy v1 FastAPI
endpoint: it authenticates the caller, resolves an enabled configured action
from persisted v1 configuration, validates it through the registry, and can
execute `open_url`, `application`, `system_control`, `keyboard_shortcut`, and
`run_command` using their existing bounded definitions. `system_monitor` is
read-only and rejected by the execution endpoint. The v1 shortcut dispatcher
uses Win32 `SendInput` for allowlisted input to the active foreground window.
This does not implement v2 epoch/revision catalogue checks, the v2
`windowsAction` message, request idempotency/status, or any v2 protocol message
handling. V2 action requests therefore remain unsupported.

## 5. Acknowledgements and errors

`message.ack` uses `in_reply_to` and one stage:

- `configuration.persisted`: recipient has validated and durably stored the
  stated epoch/revision. Include both fields.
- `action.accepted`: the host authenticated, validated, deduplicated, and
  durably recorded the action request. Include `request_id`.

An acknowledgement is not an action result. `action.result` is authoritative
for the execution outcome.

Protocol errors use this stable shape:

```json
{
  "protocol_version": 2,
  "message_id": "00000000-0000-4000-8000-000000000006",
  "type": "protocol.error",
  "in_reply_to": "00000000-0000-4000-8000-000000000005",
  "payload": {
    "code": "revision_mismatch",
    "message": "The action was created from a stale configuration revision.",
    "retryable": false,
    "details": []
  }
}
```

`details` is optional and contains bounded `{path, message}` entries without
secrets. Core codes are enumerated in the JSON schema. Error policy:

| Condition | Code | Retry/connection behavior |
| --- | --- | --- |
| Invalid JSON, envelope, or unsupported message | `invalid_message` | Do not apply it; close after the protocol error. |
| No mutually supported version | `unsupported_protocol` / `unsupported_configuration` | Non-retryable until client/server software changes; close. |
| Missing, invalid, or revoked credential | `unauthorized` / `revoked` | Never retry with the same credential; close and require re-pairing/reauthentication. |
| Epoch/base revision mismatch or missed history during configuration sync | `revision_mismatch` / `snapshot_required` | Retain local state and request a full snapshot. |
| Unknown delta operation or malformed parent/index/entity value | `invalid_configuration_operation` | Reject the full delta; retain the previous snapshot and request a full snapshot. |
| Stale epoch/revision on an action request | `revision_mismatch` | Do not replay the action. Synchronize configuration and require a new user press. |
| Invalid schema, reference, target, parameter, or capacity | `invalid_configuration` / `invalid_action` | Reject atomically; fix source document/request. |
| Local durable write failure | `configuration_persistence_failed` | Keep previous snapshot, report, and retry only after storage recovers. |
| Action absent, not Windows-targeted, or not authorized by policy | `action_not_found` / `action_forbidden` | Do not execute; user/admin intervention may be required. |
| Executor reports failure | `action_execution_failed` | Return failed `action.result`; no false success. |
| Device reuses an action request ID with different request content | `idempotency_conflict` | Return no new execution; query the original request status. |
| Action status key is unknown or beyond retention | `request_not_found` / `request_expired` | Return `unknown`; never reinterpret it as a new action request. |
| Telemetry subscription has stale epoch/revision or invalid interval | `invalid_telemetry_subscription` / `revision_mismatch` | Reject subscription; no action execution. |
| Rate/capacity limit | `server_busy` | Retry only after server-directed backoff; do not spin. |

## 6. Read-only Windows telemetry

Telemetry is available only for an authenticated, authorized device and is
separate from action execution. The client requests a stream with
`telemetry.subscribe`, including the current `config_epoch`, exact
`config_revision`, and desired interval (2.5 to 60 seconds). The host accepts
only the currently published revision and clamps/validates this interval. It
responds with `telemetry.subscribed`, a random `stream_id`, selected interval,
and expiry duration. The stream expires after at most three sample intervals;
the client must resubscribe after expiry/reconnect. `telemetry.unsubscribe`
stops it explicitly.

Each bounded `telemetry.update` contains a monotonically increasing per-stream
sequence, epoch/revision, `sampled_at`, `expires_at`, and the current Windows
metrics:

- CPU: `sampling`, `available` with a 0-100 percentage, or `unavailable` with
  a reason. The first counter sample is `sampling`; no fabricated value is
  allowed.
- Physical RAM: `available` with used/total bytes, or `unavailable` with both
  values null and a reason.
- GPU utilization and CPU/GPU temperatures: always explicitly
  `unavailable`/`unsupported` with a bounded reason until a trustworthy
  Windows provider is implemented. Do not substitute Android-device metrics.

The client discards updates from another stream, epoch, revision, or stale
sequence. It renders data as expired once `expires_at` passes, even if the
socket remains open. A heartbeat is not a telemetry refresh. Telemetry
messages obey the 16 KiB limit and contain no action/control fields. The v1
`GET /api/system/metrics` remains unchanged and loopback-only; this section is
the future v2 WebSocket contract, not an implemented endpoint.

## 7. Heartbeat, disconnect, reconnect, and states

The client sends `client.ping` periodically (target interval 20 seconds); the
server answers `server.pong` with its current config head. A peer is considered
dead after three missed heartbeat intervals. These timing values are
configuration defaults, not message semantics, and may be tuned without a
protocol-version change.

On disconnect, mark the transport unavailable. Continue Android-local actions
from the last committed configuration; disable Windows-targeted actions and
show that the host is offline. Reconnect using bounded exponential backoff
starting at 500 ms and capped at 30 seconds, with jitter; pause after eight
consecutive failures and expose an explicit retry path. Reauthenticate on
every new transport session, send `client.hello` and `config.sync`, then
reconcile before declaring configuration sync complete. Do not replay pending
Windows actions after reconnect.

Connection state machine:

`disconnected -> discovering (transport-specific) -> connecting -> authenticating -> negotiating -> syncing -> ready`

Any state can move to `revoked`, `unsupported`, or `error`. A transient
transport loss returns to `disconnected`; successful authentication does not
mean configuration is synchronized. `ready` means the session is authorized
and the last accepted configuration matches the server head (or has been
explicitly marked current).

## 8. Security, compatibility, and implementation notes

- Pair through a short-lived, single-use code and explicit Windows-user
  approval. Bind a device ID/type to a high-entropy credential; never let a
  claim request choose its authorized role. Pairing transport, approval and
  credential storage follow the bootstrap rules in section 2.
- Windows stores only a verifier for device credentials and rechecks
  authorization on every new session and while a session is active where the
  transport permits. Revoke by device ID and close active sessions. Revocation
  cannot contact an offline device; it is enforced on reconnect.
- Android stores credentials encrypted with Android Keystore-backed
  app-private storage, excludes them from backup, and never logs them. Clear
  them on logout/re-pair.
- Keep the administrator credential distinct from paired device credentials.
  Do not persist a release-generated desktop admin token just to simplify
  pairing.
- A protocol major is exact; do not use unknown fields as a downgrade or
  capability negotiation mechanism. Additive optional fields require a
  deliberate compatible minor-version policy before introduction; this v2
  schema currently does not claim such a policy.
- IDs are stable across migration. Revisions are monotonic inside an epoch.
  Action results and errors never include credentials or full configuration
  documents.
- The existing WebSocket v1 events and FastAPI REST contracts remain a
  legacy desktop contract until a migration is implemented and tested.
