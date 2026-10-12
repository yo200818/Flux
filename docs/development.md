# Development workflow

The React, TypeScript, and Vite frontend is shared by the Windows Tauri
application and a standalone browser build. It checks backend health, displays
and edits the persisted configuration, and can request explicitly enabled
allowlisted actions. The FastAPI backend provides configuration, action,
device-authorization, pairing, and authenticated WebSocket endpoints. For the
architecture and milestones, see
[`architecture.md`](./architecture.md).

## Working approach

1. Work on one small architecture milestone at a time.
2. Keep desktop UI, backend responsibilities, shared definitions, and tests in
   their respective top-level folders.
3. Add only the files and dependencies needed for the current milestone.
4. Add focused automated tests with each behavior; do not defer testing until
   integration.
5. Validate client input at the Windows host and route PC actions only through
   an explicit action registry. Never expose unrestricted shell execution.
6. Keep future clients and transports clearly deferred until they are designed
   and implemented.

The requested `frontend/` directory is used for the desktop application in
place of the architecture document's initial `apps/desktop/` proposal.
Frontend setup and verification commands are documented in
[`../frontend/README.md`](../frontend/README.md).

The backend is restricted to loopback and is not a LAN or public-network
service. Do not bind it to `0.0.0.0`; there is no TLS or remote deployment
support.

## Running the backend

The backend provides health and persistent configuration endpoints, versioned
configuration validation, and an allowlisted registry of supported action
definitions. It can open explicitly enabled `open_url` actions through
Python's standard `webbrowser` module and, on Windows, send enabled
`keyboard_shortcut` actions to the active foreground window using Win32
`SendInput`. Configuration and action requests require an authorized
administrator or paired device; pairing administration requires the
administrator token. See the authentication notes below.
Run the following commands from the repository root in PowerShell:

```powershell
py -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --reload
```

The API health check is available at `http://127.0.0.1:8000/api/health`, and
the current configuration is available at
`http://127.0.0.1:8000/api/config`.
`PUT /api/config` accepts a full configuration document and replaces the
active value only after validation and successful atomic persistence. The
configuration file defaults to
`%APPDATA%\PocketDeck\configuration.json` on Windows; elsewhere the fallback
is `~/AppData/Roaming/PocketDeck/configuration.json`. Set
`POCKETDECK_CONFIG_PATH` to an absolute file path to select another location
for development or testing. The file stores a revision and the validated
configuration in a JSON envelope.

`GET /api/config` and successful `PUT /api/config` responses return
`{"revision": 0, "configuration": {...}}`. The PUT body remains the
configuration document; optionally pass `expected_revision` as a query
parameter to prevent replacing a newer version. A mismatch returns HTTP 409
with expected and current revisions. Invalid documents return HTTP 422 with
field or cross-reference details. A persistence failure returns HTTP 500 and
leaves both the active and saved configuration unchanged. The revision
increments only after a successful write.

On first run, the backend atomically creates the default configuration at
revision 0. On startup, it loads and validates the saved file. If the file is
corrupt or invalid, startup fails with a clear error and the file is not
overwritten; repair or move the file to recover. Updates are written to a
temporary file in the same directory, flushed, and replaced atomically.
`POST /api/actions/{action_id}/execute` requests execution of an action already
declared in the current configuration and assigned to a button. The action
must have `enabled_for_execution: true` and pass registry validation.
`open_url` accepts only a validated HTTP or HTTPS URL and opens it through the
operating system's default browser; a false return or browser-opening exception
is reported as a failed result. On Windows, `keyboard_shortcut` injects the
allowlisted Ctrl or Alt+Tab sequence into the active foreground window. The
backend reports success when Windows accepts all input events, not when the
target application confirms the operation. The action is unavailable on other
platforms and can be blocked when the backend/target privilege levels differ.
Configuration loading and updates never execute actions. Arbitrary shell,
PowerShell, Python, scripts, and executable paths are not supported.
Stop the development server with `Ctrl+C`.

### Device pairing and authentication foundation

Pairing administration is disabled unless `POCKETDECK_ADMIN_TOKEN` is set to
a random secret of at least 32 bytes before starting the backend. In
PowerShell, create a process-local 256-bit token without putting it in command
history:

```powershell
$adminBytes = New-Object byte[] 32
$adminRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$adminRng.GetBytes($adminBytes)
$adminRng.Dispose()
$env:POCKETDECK_ADMIN_TOKEN = [Convert]::ToBase64String($adminBytes)
```

Keep this value private. Administrative requests send it only in an
`Authorization: Bearer ...` header. The backend does not write this secret to
the device registry or logs. If the variable is not configured,
administrative pairing and device-management routes return HTTP 503.

The pairing lifecycle is:

1. An administrator calls `POST /api/pairing/sessions`. The response includes
   a cryptographically random six-digit pairing PIN and its expiration
   (three minutes).
2. A prospective client submits that code, a validated display name, and one
   of `desktop`, `android`, `ios`, `web`, or `pocketdeck_os` to
   `POST /api/pairing/claim`. A valid code can be claimed once. This creates a
   pending request, not an authorized device.
3. The Windows user reviews pending requests using
   `GET /api/pairing/requests`, then calls either
   `POST /api/pairing/requests/{request_id}/approve` or `/reject`. These
   administrative endpoints require the bearer admin token. There is no
   desktop approval UI yet.
4. Approval returns a generated device ID and a high-entropy bearer credential
   once. The client must securely retain it; the backend stores only its
   SHA-256 digest. The plaintext device credential is returned only by the
   successful approval response and is not included in device listings,
   authentication responses, or logs. If the client loses the credential,
   revoke that device and pair it again.
5. A paired client can verify its credential with `GET /api/devices/me`.
   Device credentials are checked against current authorization state on each
   such request. `DELETE /api/devices/{device_id}` revokes a device; its
   credential is then rejected.

The device registry defaults to
`%APPDATA%\PocketDeck\devices.json` on Windows. Set
`POCKETDECK_DEVICE_STORE_PATH` to an absolute path for development or tests.
Registry updates use atomic replacement; the file contains device metadata,
authorization/revocation status, and credential digests, never plaintext
pairing codes or device credentials. Pairing sessions and pending requests
are held in memory, removed on expiry, and do not survive a backend restart.
Expired, rejected, and already-claimed codes cannot authorize a device.
Pairing PINs are six-digit numeric secrets, expire after three minutes, are
single-use, and claims are rate-limited. The separate QR code provisions the
TLS certificate pin and companion identity; it does not contain the PIN.

Device credentials authorize protected configuration and action requests.
Desktop and web clients can edit configuration; other paired client types are
read-only. WebSocket upgrades require a valid device/admin bearer credential
in the versioned subprotocols and an exact allowlisted Origin. Credentials are
rechecked when processing messages and broadcasts. This is suitable only for
the loopback desktop/browser workflow: there is no TLS, mobile clients are not
supported by this UI, and the browser credential is held in memory only. The
browser UI currently accepts an already-paired `web` device credential; it
does not provide pairing approval. Never expose the service to a LAN.
The WebSocket protocol still accepts only `client.ping`; it never executes PC actions.

### Local WebSocket updates

Connect to `ws://127.0.0.1:8000/ws` for local development events. REST remains
the authoritative interface for retrieving and updating configuration. The
version 1 server event envelope is defined by
[`../shared/schemas/v1/events.schema.json`](../shared/schemas/v1/events.schema.json):

```json
{
  "protocol_version": 1,
  "event_id": "4ce67415-0032-48a8-92e4-e11ed2654a72",
  "type": "config.updated",
  "revision": 3,
  "payload": {}
}
```

`connection.ready` includes the revision currently held by the backend.
`config.updated` is broadcast to connected clients only after a valid update
has been atomically persisted, and contains the new revision but not the
configuration itself. Each server event has a unique UUID event ID. The
server accepts only version 1 `client.ping` messages (and answers with
`server.pong`), in this shape:

```json
{"protocol_version": 1, "type": "client.ping"}
```

Malformed or unsupported messages receive `protocol.error` and the socket is
closed. WebSocket messages cannot update configuration or execute PC actions.
No secrets or configuration content are broadcast.

The desktop reconnects up to eight times with exponential backoff starting at
500 ms and capped at 10 seconds. It ignores duplicate or stale revisions and
fetches authoritative configuration over REST when a newer revision is
announced. Button and grid drafts remain in frontend state while the latest
configuration is refreshed; saves use the current revision and report a
revision conflict without silently discarding the draft.

To run the backend tests from the repository root:

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests
```

## Connecting the desktop frontend to the backend

During development, keep the backend command above running in one PowerShell
terminal and start the frontend in another terminal from `frontend/`. The
development workflow deliberately continues to use a separately managed
backend:

```powershell
npm install
npm run dev
```

In Vite development mode, open `http://localhost:1420` or
`http://127.0.0.1:1420`. The packaged executable creates an ephemeral
administrator credential for its owned backend. In development, provide the
same private `POCKETDECK_ADMIN_TOKEN` value to both separately launched
processes; the Tauri UI retrieves it from its desktop command. The app checks
`GET /api/health`, then loads the saved configuration, and lets you switch
profiles/pages, customize the grid, and edit buttons. Supported enabled
`open_url` and enabled Windows keyboard shortcut actions execute through the
backend. Authenticated WebSocket updates trigger a REST refresh for a newer
revision.

## Running the browser client

The browser client reuses the same React application and does not start or
package a backend. Keep the FastAPI backend running in a separate terminal,
then start Vite from `frontend/`:

```powershell
npm run dev:web
```

Open `http://127.0.0.1:5173`. This exact loopback Vite origin is included in
the development CORS and WebSocket Origin allowlists. The client connects to
`http://127.0.0.1:8000` by default. To use another backend, set
`VITE_API_BASE_URL` in `frontend/.env.local` and configure the backend's
`POCKETDECK_CORS_ORIGINS` with the exact browser origin; never use wildcard
origins or a non-loopback backend for this workflow.

Browser access requires a previously paired `web` device credential. Enter it
in the browser authorization form; it is held in memory only and is cleared
on reload or disconnect. Pairing approval currently requires the authenticated
administrator API; this frontend does not expose an approval screen. The
browser can edit shared configuration and request backend-supported actions
when its paired credential is authorized. Keyboard input is executed by the
Windows backend, not browser JavaScript, and targets the active foreground
window. Use
`npm run build:web` for a standalone production bundle and
`npm run preview:web` to preview it on port 5173. The preview port is chosen
to match the allowlisted development origin; production hosting requires its
own exact CORS/Origin configuration and an appropriately protected backend.

The Windows Tauri webview uses the `http://tauri.localhost` origin. The backend
allows that exact origin for local desktop API requests, and the Tauri CSP
permits only the required `http://127.0.0.1:8000` and
`ws://127.0.0.1:8000` destinations (along with the existing Vite HMR entries).
These settings do not expose the backend to the LAN. The backend still binds
to loopback by default.

Packaged Windows Tauri builds bundle a self-contained backend executable and
its runtime files, produced by PyInstaller in onedir mode so the desktop owns
the exact process that serves the API. The `websockets` runtime dependency is
collected explicitly because Uvicorn otherwise starts without a WebSocket
transport. The default configuration example is
explicitly collected at `shared/examples/config.v1.json` within the PyInstaller
resource directory; the shared v2 configuration schema is bundled at
`shared/schemas/v2/config.schema.json` for authenticated WebSocket snapshots and
migration validation. Development resolves both resources from the repository
layout. User configuration remains under `%APPDATA%\PocketDeck\configuration.json`
or the existing `POCKETDECK_CONFIG_PATH` override. Install the build-only
dependency from the repository root before packaging:

```powershell
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-build.txt
```

From `frontend/`, `npm run tauri build` builds the backend before the frontend
and installer. The packaged app starts the backend on `127.0.0.1:8000` before
the UI checks health, verifies the responding process ID, and displays a
startup error with the backend log path if launch or readiness fails. On app
exit (including a close request for the last application window) it stops and
waits for only the child process it started; it never kills a process based on
port ownership or process name. The backend log is written under the Tauri
app-local data directory in `logs\backend.log`.

The desktop development workflow remains unchanged: start Uvicorn in its own
terminal before running `npm run dev` or `npm run tauri dev`. The backend
remains bound to loopback only. The Tauri CSP remains restrictive and permits
only the required loopback API/WebSocket destinations and existing Vite HMR
entries. A local process occupying port 8000 can prevent the packaged backend
from starting, but PocketDeck will not terminate that unrelated process.

To use a different backend URL in Vite, copy `frontend/.env.example` to
`frontend/.env.local`, set `VITE_API_BASE_URL`, then restart the Vite server.
The Tauri CSP and backend CORS allowlist must also be deliberately adjusted for
any non-default endpoint or webview origin; avoid wildcard permissions.

The backend CORS and WebSocket Origin allowlists include Vite origins on ports
`5173` and `1420` for both `localhost` and `127.0.0.1`, plus the exact Tauri
origin `http://tauri.localhost`.

Run frontend checks from `frontend/`:

```powershell
npm run lint
npm test
npm run build
```

## Shared configuration and action registry

The transport-independent version 1 JSON schema is
[`../shared/schemas/v1/config.schema.json`](../shared/schemas/v1/config.schema.json);
[`../shared/examples/config.v1.json`](../shared/examples/config.v1.json) is a
small valid example. A configuration has `schema_version`, `profiles`, and
`actions`. Profiles contain pages. Each page defines a grid and an ordered
button list; button order maps row by row to grid cells. Buttons carry a stable
ID, label, optional icon reference, and `action_id` referring to a declared
action. Action entries have a stable ID, a registered `type`, structured JSON
`parameters`, and an `enabled_for_execution` boolean. If it is omitted,
the backend defaults it to false; execution requires the value to be explicitly
set to the JSON boolean `true` (string and numeric values are rejected).

IDs are strings of 1–64 letters, digits, underscores, or hyphens, starting
with a letter or digit, and must be unique across profiles, pages, buttons, and
actions. Profiles and pages require at least one entry and are limited to 32
each; configurations allow at most 128 actions; grids allow 1–8 rows and
columns, with no more than 64 cells or buttons per page. A page cannot contain
more buttons than grid cells. Labels are limited to 64 characters and icon
references to 128 characters.

The backend Pydantic models validate the structure and cross-references.
`app.config.models.validate_configuration` additionally checks global ID
uniqueness, button action references, grid capacity, and action parameters
against the registry. Validation failures expose a structured code and details
without embedding the rejected input.

The registry in `backend/app/actions/` supports registering, listing, looking
up, and validating action definitions. The execution service accepts only
enabled, button-referenced actions and validates their parameters again before
dispatch. `open_url` uses Python's standard `webbrowser` module and reports
success only when the operating system accepts the request. On Windows,
`keyboard_shortcut` uses the Win32 `SendInput` API for the fixed shortcut
allowlist and sends input to the active foreground window. The desktop must
run at the same or higher privilege level as the target; Windows may reject
injected input across integrity levels. A successful result means the input
sequence was accepted, not that the target application completed the
operation. The dispatcher is unavailable on non-Windows hosts. The registry
supports:

- `open_url`: requires an HTTP or HTTPS URL and is enabled in the sample.
- `keyboard_shortcut`: accepts one of `copy`, `paste`, `cut`, `undo`, `redo`,
  `save`, `select_all`, or `switch_app`; it sends the matching Ctrl or Alt+Tab
  input sequence through Win32 on Windows.

Unknown action types and extra or invalid parameters are rejected. There is no
shell, script, or executable-path action. To add a future executable type,
define a strict Pydantic parameter model, explicitly register it, and add a
reviewed dispatcher branch and tests.

### V1 and V2 configuration transition

The running backend and editor remain strictly on schema v1. On startup, the
backend loads `%APPDATA%\PocketDeck\configuration.json` (or
`POCKETDECK_CONFIG_PATH`), validates it as v1, and leaves an unreadable or
invalid saved file untouched while failing startup with an actionable storage
error. First run loads and validates `shared/examples/config.v1.json` and
persists it as the user's v1 configuration. A v2 document is not sent to the
v1 API, and no automatic conversion or overwrite occurs.

When a v2 runtime is implemented, migration must be an explicit, validated
operation: retain every profile/page/button/action ID and order, button label,
icon, and color; create and persist one stable `deck.id`; preserve each
action's enabled state and parameters; and map legacy actions conservatively
to `windows_host` because v1 did not encode execution targets. Validate all
v2 constraints, action references, targets, parameters, grid capacity and IDs
before publication. Write a recoverable backup, then atomically commit the
migrated representation only after validation succeeds. On any failure, keep
the original v1 file and active configuration unchanged. Continue supporting
v1 clients until an explicit compatibility/removal decision is made. These
migration steps are a contract, not an implemented converter.

Run the configuration and action-registry tests from the repository root:

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests
```
