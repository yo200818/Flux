# Action Target and Execution Boundary (Configuration v2)

**Status:** Contract finalized for protocol v2; target-aware runtime validation
is not yet implemented. See [protocol-v2.md](./protocol-v2.md) for message
envelopes, authentication, errors, acknowledgements, and retry rules.

## Configuration contract

An action is a configuration-owned declarative record with exactly these
security-relevant fields:

```json
{
  "id": "open-site",
  "target": "windows_host",
  "type": "open_url",
  "enabled_for_execution": true,
  "parameters": {
    "url": "https://example.com/"
  }
}
```

- `id` is globally unique and referenced by button `action_id`.
- `target` is exactly `android_local` or `windows_host`. It describes where
  execution occurs, never how the message is transported.
- `type` is a registered semantic operation, not a command or code string.
- `parameters` are strict, type-specific data; unknown fields are rejected.
- `enabled_for_execution` expresses configuration/UI intent. It never grants
  authority by itself.

The v2 JSON Schema defines `open_url` with an HTTP(S) URL (maximum 2048
characters) and `keyboard_shortcut` with a built-in shortcut ID or a validated
modifier chord. A keyboard shortcut must target `windows_host`. The current v1
Windows backend dispatches its allowlisted shortcuts through the Windows
`SendInput` API. This only injects the key sequence into the active foreground
window; it does not select an application or prove that the application
performed the requested operation. The v2 schema presence still does not mean
that the v2 authenticated action protocol or its policy checks are implemented.

The v1 `application` action stores a friendly name and an absolute Windows
executable path. The Tauri desktop app uses a native Windows file dialog to
choose the path; the backend rechecks the `.exe` path and file existence at
launch, then passes exactly that executable as a one-element argument list to
`subprocess.Popen` with `shell=False`. It does not accept command-line
arguments or interpret command strings. Selecting a path is not a security
certification: an executable runs with PocketDeck's user privileges and may
perform any operation that user can perform. Only choose software you trust.
The v2 schema describes this action as Windows-host-only; v2 runtime dispatch
remains unimplemented.

The v1 `system_control` action accepts only the five named operations
`volume_up`, `volume_down`, `mute_toggle`, `brightness_up`, and
`brightness_down`. Volume operations send only their corresponding Windows
multimedia key. Brightness uses the Windows monitor brightness API for physical
displays whose drivers expose controllable brightness; laptop panels and
external displays without that support return an explicit failure. No shell or
command string is involved.

The v1 `system_monitor` type is a read-only button widget, not an executable
action. Its action record must have `enabled_for_execution: false`, and the
action execution endpoint rejects it regardless of its configuration. The
authenticated `GET /api/system/metrics` endpoint reports Windows CPU utilization
using `GetSystemTimes` counter deltas and physical memory usage using
`GlobalMemoryStatusEx`. CPU shows a sampling state until two counter samples
exist. The frontend polls sequentially at a 2.5-second interval and cancels its
pending request/timer when the monitored page is no longer active or unmounts.
GPU utilization, GPU temperature, and CPU temperature are reported unavailable:
there is no generic trustworthy Windows sensor API implemented here. No
hardware-specific telemetry dependency is bundled, and no readings are
fabricated. The v2 configuration schema describes the read-only widget, but the
v2 runtime remains unimplemented.

## Client dispatch

1. Android loads its last durably accepted `{config_epoch, revision,
   configuration}` at startup.
2. On a press, Android resolves `button_id -> action_id -> action` locally,
   confirms the target, and validates the parameters. It does not call the
   Windows configuration API to resolve a press.
3. For `android_local`, Android invokes only a local allowlisted implementation
   and reports local success/failure. It sends no Windows execution request.
4. For `windows_host`, Android sends an authenticated `action.execute`
   containing a unique message/idempotency ID, button ID, action descriptor,
   and source config epoch/revision. It does not send shell text, a process
   path, or a generic instruction to execute arbitrary data.
5. Android disables only Windows-targeted actions when the Windows host is
   disconnected, revoked, or still synchronizing. Local actions can continue
   using the persisted configuration while offline.

In the v1 Windows UI, a `system_monitor` assignment is rendered as a read-only
widget and refreshed through the authenticated metrics endpoint; it is never
sent to the action execution endpoint. The v2 protocol does not implement
monitor dispatch.

## Windows validation for every incoming request

Treat all fields from Android as attacker-controlled, including button/action
IDs, target, type, parameters, revisions, and the `enabled_for_execution`
value if one is ever added to the request. Before any side effect, Windows:

1. Verifies the session credential, device ID, authorization state, and
   permission to request Windows actions.
2. Verifies the active config epoch and exact current revision; stale requests
   are rejected and never silently mapped to a newer action.
3. Resolves the button/action relationship from a bounded in-memory catalogue
   compiled from the validated, published Windows configuration. The supplied
   action ID, type, target, and parameter object must exactly match that
   catalogue entry. This local in-memory lookup is not an Android
   configuration fetch or a per-press REST lookup.
4. Requires `target == "windows_host"` and validates the action type and
   parameters again through the host registry. The registry, host execution
   policy, and authenticated device role—not client flags—decide whether it
   may run.
5. Checks and durably records the idempotency key before dispatch. Duplicate
   keys return the recorded state/result. If a crash leaves an in-progress
   action, report an unknown outcome; never automatically replay it.
6. Executes through a narrow registered handler and returns an explicit
   result. Unknown, disabled, stale, malformed, unauthorized, or unsupported
   actions cause no side effect.

The current FastAPI action endpoint is not this v2 boundary. It accepts an
action ID, authenticates an administrator or paired device credential, loads
the active persisted v1 configuration, checks assignment and enablement, and
validates through the action registry. The v1 registry now also supports
`run_command`, which resolves an ID only against a saved command definition in
the authoritative configuration, and the bounded `wait` step inside a
command. It does not accept a client-supplied definition at execution time.
Retain this v1 API and its authentication until a separate, tested v2 command
path replaces it without weakening its protections.

## Current registry mapping and limitations

| Type | V2 target | Parameter contract | Current status |
| --- | --- | --- | --- |
| `open_url` | `android_local` | `{ "url": "https://..." }` | Future Android registry action; not implemented. |
| `open_url` | `windows_host` | `{ "url": "https://...", "name": "Optional label" }` | Existing Windows handler opens the system browser for an enabled configured action; older unnamed entries remain supported. |
| `application` | `windows_host` only | `{ "name": "...", "path": "C:\\Program Files\\Vendor\\app.exe" }` | V1 Windows action launches exactly the selected executable without a shell; it is subject to user-level executable trust and is unavailable off Windows. |
| `system_control` | `windows_host` only | `{ "control": "volume_up" }` (one of five fixed operations) | V1 Windows action maps volume to multimedia keys and brightness to available monitor controls; unsupported brightness returns a failure. |
| `system_monitor` | `windows_host` only | `{ "metric": "cpu_utilization" }` (CPU, memory, GPU, or temperature metric) | V1 Windows UI polls CPU and physical memory via native APIs; GPU and temperature sensors are explicitly unavailable, and this read-only type is rejected by action execution. |
| `keyboard_shortcut` | `windows_host` only | Built-in shortcut IDs or a validated Ctrl/Alt/Shift/Windows chord / saved shortcut ID | V1 Windows backend sends allowlisted input to the current foreground window. It is unavailable off Windows; execution requires an enabled action and an authenticated request. |
| `run_command` | V1 Windows action | `{ "command_id": "<saved-id>" }` | Resolves the saved v1 command, requires both its command and action to be enabled, and executes its validated sequence in order. |
| `wait` | V1 saved-command step only | `{ "milliseconds": 0..10000 }` | Bounded delay; it cannot be assigned to a button by itself. |

## V1 command studio extension

V1 configurations may omit `commands`, `shortcuts`, and `settings`; the
backend supplies empty collections and default preferences for those legacy
files. When present, definitions are validated and persisted in the same
revision-checked, atomic configuration snapshot. A command has a stable global
ID, `definition_version: 1`, an independent display name/category, an enabled
flag, and 1–20 steps. Supported steps are validated HTTP(S) URL launches,
allowlisted keyboard shortcuts (including a saved shortcut ID), and a delay
of at most 10 seconds. Nested commands, unknown fields, dangling references,
and invalid shortcut chords are rejected. Sequences stop at the first failed
step and report its position; the synchronous v1 endpoint cannot cancel a
sequence after dispatch has begun.

Custom shortcut chords use the canonical modifier order `CTRL`, `ALT`,
`SHIFT`, `WIN`, followed by one supported key. They support letters, digits,
F1–F24, navigation/editing keys, common punctuation keys, and standard numpad
digits and operators. Existing lower-case and noncanonical modifier-order
chords are normalized when loaded and saved. Duplicate modifiers, unsupported
keys, unmodified keys, and the Windows-reserved `WIN+L` and `WIN+R` chords are
rejected.
Other Windows-key combinations may be intercepted or reserved by Windows; the
recorder warns users that their behavior depends on the OS and system policy.
The `Fn` key is not supported unless a particular keyboard and driver expose
it as a normal Windows key event. Many keyboards handle `Fn` in firmware, so
Windows cannot observe or record it.

In the Windows desktop app, shortcut recording temporarily installs a
`WH_KEYBOARD_LL` hook only while the recorder is active. It suppresses keyboard
events during that brief recording session, reports captured keys to the
recorder, and is removed on save, cancel, clear, recording errors, and app
exit. Unmodified ordinary keys pass through; modifier keys and keys pressed
while modifiers are held are suppressed for capture. It does not call the saved-shortcut action executor. This is separate
from normal saved-shortcut execution, which continues through the allowlisted
`SendInput` implementation above. The browser-only recorder can prevent events
from reaching the page's own handlers but cannot suppress Windows-level
shortcuts.

The temporary hook can suppress combinations such as `WIN+SHIFT+S`,
`PRINTSCREEN`, and `ALT+TAB` only when Windows delivers their keyboard events
to the hook. Secure attention sequences and combinations intercepted below
the application hook are not recordable or suppressible by PocketDeck. The
recorder reports Print Screen as intercepted-but-unsavable because it is not a
supported shortcut key. No global hook remains installed after recording.

Punctuation and numpad keys are represented by stable names such as
`SEMICOLON`, `BACKQUOTE`, `NUMPAD7`, and `NUMPADADD`. Their resulting character
depends on the active keyboard layout and Num Lock state. `SendInput` sends
virtual-key events; it does not guarantee that an application interprets them
as a particular text character.

Buttons may explicitly have a `null` action assignment. Such a button remains
visible and editable but cannot execute until an action is assigned. Existing
button action IDs remain stable references and are not rewritten when a
command or saved shortcut is renamed or edited.
`SendInput` addresses whichever window is foreground at dispatch time; it
cannot select a target application, bypass Windows focus protection, or
guarantee delivery across privilege levels. A successful send only reports
that Windows accepted the input events.

No arbitrary shell, command-line, script, or unvalidated Android intent is a
supported action. An executable path is accepted only by the explicitly
selected Windows `application` action described above; it is launched directly
without arguments or a shell and remains trusted user-level software.
Deep links and arbitrary Android intents are not part of this contract.
