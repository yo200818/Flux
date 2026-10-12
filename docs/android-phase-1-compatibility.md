# PocketDeck Android Phase 1: Compatibility and Protocol Decisions

**Status:** Architecture and contract decision record. Android UI, Android runtime, WSS gateway, LAN access, and live synchronization are not implemented by this report.

## Decisions

- Android is a separate native Kotlin/Jetpack Compose app in `android/`; Windows remains the configuration studio, source of truth, and Windows action executor.
- Minimum supported Android version is API 23 (Android 6.0). First transport is Wi-Fi over a later, explicitly enabled WSS gateway. USB-C remains a future transport using the same protocol abstraction; no USB support is claimed.
- Android receives, validates, stores, and displays the published deck; profile/page selection is device-local. It does not edit shared configuration.
- Versioned v1 remains supported. V2 must be extended before runtime implementation to carry all accepted v1 data. The existing v1 storage/API is not converted or exposed to the LAN as part of this work.
- Export/import is a setup and recovery path. Authenticated live synchronization supersedes an imported copy after host reconciliation.
- Android-local actions are limited to a narrow registry. Every legacy action migrates to `windows_host`; migration never infers an Android equivalent from an action name.

## Compatibility Audit

| Feature | Current v1 representation and behavior | Current v2 contract | Migration rule | Android behavior / remaining issue |
| --- | --- | --- | --- | --- |
| Websites and URLs | `open_url` with HTTP(S) `url`, optional friendly `name`; Windows backend opens the default browser. | `open_url` permits either target and retains URL/name parameters. | Preserve action ID, parameters, enabled flag, and assignment; set `windows_host` to preserve existing behavior. | Migrated links dispatch to Windows. A separately authored v2 `android_local` URL may open the Android default browser after strict HTTP(S) validation. Never substitute local opening for a disconnected host action. |
| Desktop applications | `application` has friendly `name` and an absolute Windows `.exe` `path`; launch is direct, no shell or arguments. | Present and constrained to `windows_host`. | Preserve path and all fields unchanged; assign `windows_host`. | Host dispatch only. Never resolve or launch this path on Android. Show unavailable when host is not paired/current. |
| Saved commands and ordered steps | Optional `commands` (up to 64); each has stable ID, `definition_version` (default 1), name, optional description/category/enabled defaults, and 1–20 ordered `open_url`, `keyboard_shortcut`, or bounded `wait` steps. `run_command` action refers to a saved `command_id`; both action and command must be enabled. Steps stop on first failure. | V2 now represents commands, metadata/defaults, ordered URL/shortcut/wait steps, and host-only `run_command`. | Preserve command and action IDs, ordering, defaults/values, references, and enabled states. Reject unsupported/malformed fields. Keep `system_monitor` forbidden in steps and disallow nested commands. | Dispatch the saved command ID to Windows; host resolves the published definition and runs only registered bounded steps. Android never interprets a command as code or executes its steps locally. |
| Saved shortcuts and keyboard combinations | Optional `shortcuts` (up to 64) contain stable ID/name/canonical chord. Actions and command steps can use either an inline shortcut or `shortcut_id`. Registry excludes duplicate/unsupported/reserved chords. | V2 represents saved shortcuts and allows exactly one of inline `shortcut` or `shortcut_id`. | Preserve saved shortcut objects and IDs, direct values, and references. Inline legacy chords are canonicalized through the existing normalizer when necessary to meet v2's canonical spelling. | Shortcut actions and command steps are Windows-only. Android never injects keyboard input; dangling/invalid shortcut references reject the whole import/snapshot. |
| System controls | `system_control` is one of `volume_up`, `volume_down`, `mute_toggle`, `brightness_up`, `brightness_down`; backend maps only these fixed operations. Brightness may be unsupported by a display/driver. | Present and restricted to `windows_host`. | Preserve action ID/control/enabled state; assign `windows_host`. | Windows dispatch only; report offline/unsupported explicitly. No Android volume/brightness substitution. |
| CPU/RAM monitoring and sensors | `system_monitor` is a non-executable button widget (`enabled_for_execution=false`). Authenticated Windows REST metrics provide CPU sampling/percentage and physical RAM; GPU utilization and CPU/GPU temperatures are explicitly unavailable. | V2 preserves a read-only `system_monitor` action, host-targeted and disabled, including all five metric identifiers. Protocol has no telemetry messages. | Preserve widget/action/button data. Keep it read-only; reject it as a command step. | Include read-only Windows CPU/RAM telemetry in the Android milestone through new allowlisted telemetry messages. Unsupported GPU/temperature metrics remain visibly unavailable; do not fabricate or substitute Android metrics. Offline values become stale/unavailable. |
| Profiles, pages, buttons, appearance | Ordered arrays; IDs/names; grid 1–8 rows/columns; button order is row-major; label, optional icon/color, nullable action assignment. V1 permits 32 profiles/pages, 64 buttons/page and validates grid capacity. | Core structure/order/labels/colors are present; empty profiles/pages are now legal; icon may be string or null. | Preserve arrays and every representable field/order/assignment. Do not resize grids or generate child IDs. Unknown icon names use a safe fallback. | Display without mutating shared configuration. Profile/page selection is local device state. |
| Settings / command confirmation | Optional `settings.confirm_commands` boolean defaults false. Current React grid prompts before `run_command` when true; this is UX, not a backend authorization check. | V2 represents optional `settings.confirm_commands`. | Preserve the setting and its value in v2; v1 omission is emitted with its effective default. | Honor it as an Android confirmation prompt before host command dispatch; it does not grant permission or replace Windows validation. |
| Stable IDs and references | Backend semantic validation enforces global uniqueness across profiles, pages, buttons, actions, saved shortcuts, and commands; buttons, command actions, and shortcut references must resolve. | V2 includes commands/shortcuts and their references; semantic uniqueness is enforced by the migration validator. | Preserve all existing IDs; deterministically derive only the new `deck.id`; reject a collision and validate all references before accepting it. | IDs are opaque stable identifiers. Never create new IDs during import retries or synchronization. |
| Additional fields and limits | `schema_version: 1`; optional commands/shortcuts/settings; optional action enablement defaults false in backend models; URL `name`; command metadata/defaults; optional/null `icon` is accepted by Pydantic/frontend although the v1 JSON Schema currently says string only. | `schema_version: 2`, required `deck`, `profiles`, `actions`; optional commands/shortcuts/settings; explicit action targets. | Preserve supported defaults and nullable icon behavior in v2. Keep strict unknown-field rejection; do not silently carry arbitrary extension data. Record v1 schema/backend icon-null drift for a later v1 schema correction. | Validate the v2 shape and v1 semantic constraints; reject unsupported values with a useful import error rather than dropping them. |

Other observed limits: v1 allows up to 32 profiles and pages/profile, 128 actions, 64 commands and shortcuts, 20 steps/command, and 10 seconds/wait. The backend's v1 `Configuration` model and `ConfigurationStore` accept only schema version 1; no migration function or v2 runtime/store exists. Existing revision storage is an integer only.

## Lossless Migration Design

Extend the **unimplemented v2 contract** with the smallest additive data surface required for v1 parity:

1. Add optional `commands`, `shortcuts`, and `settings` top-level properties using the existing v1 shapes and strict field/size limits. V1 omission defaults remain semantically equivalent to empty collections and `confirm_commands=false`.
2. Add a `run_command` action with `{command_id}` parameters, allowed only at `target: windows_host`. Add the exact v1 command definition and ordered step forms (`open_url`, `keyboard_shortcut`, `wait`); preserve `definition_version`, name, description, category, enabled, and step order. `wait` is legal only within a saved command and remains bounded to 0–10,000 ms.
3. Add saved shortcut definitions and allow exactly one of inline `shortcut` or `shortcut_id` for shortcut actions/steps. Keep the existing canonical chord allowlist and reserved-combination rejection.
4. Extend semantic validation and permitted delta paths to commands, shortcuts, and settings. Enforce references, global uniqueness across all entity IDs, all action/type/target combinations, and the existing full-document limits. `system_monitor` stays read-only and is rejected in every executable command-step context.
5. For each valid v1 input, preserve every stable ID, action parameter, enablement value, command step, shortcut, setting, profile/page/button order, label, icon, color, grid, and assignment. Map **all** legacy actions to `windows_host`, including `open_url`, because that is their existing execution location. Only future explicitly-authored v2 actions may target `android_local`.
6. Derive the added `deck.id` deterministically as UUIDv5 from a persisted Windows installation namespace and a fixed legacy-primary-deck key. Persist that namespace once. Thus retries/restarts yield the same ID; collision or invalid output fails validation rather than silently changing existing IDs.
7. Migrate a validated copy, never rewrite the v1 input in place. Validate the complete v2 candidate before writing/publishing it. On parse, migration, validation, or persistence failure, retain the byte-identical v1 source and active snapshot. Keep v1 endpoints/config files working; define an explicit, tested cutover before v2 becomes the canonical Windows representation. Do not run two writable sources of truth.

If a source has data rejected by the actual v1 validator, migration must stop and report it; do not attempt best-effort conversion. The migration is deterministic for a fixed source and installation namespace and is not a v2-to-v2 converter.

### Migration implementation status

The pure converter is implemented at
[`../backend/app/config/migration.py`](../backend/app/config/migration.py)
as `migrate_v1_to_v2(source, installation_namespace)`. The caller must provide
the persisted Windows installation UUID namespace; the converter uses UUIDv5
and a fixed deck key, validates a deep copy with the existing v1 validator,
maps every action to `windows_host`, then validates the v2-specific deck and
target contract plus v1-compatible semantics. It performs no file writes, so a
failed migration cannot partially replace the source; storage code must commit
the returned candidate atomically only after success.

The current v1 implementation supports `run_command` as a button action that
references a saved command. It does **not** support `run_command` as a nested
command step: nested commands and `system_monitor` command steps are rejected
by v1 semantic validation and remain rejected by migration. Supported command
steps are ordered `open_url`, `keyboard_shortcut`, and bounded `wait` entries.
Inline shortcut chords are canonicalized with the existing shortcut
normalizer. Values that v1's runtime accepts but v2 cannot represent (for
example, a null URL display name or a non-integer JSON wait value) fail with a
path-specific migration error rather than being discarded.

The environment has no Draft 2020-12 JSON Schema validator installed. The
converter therefore validates the source using the actual Pydantic/action
registry contract and checks the v2 schema's required/allowed fields, deck
identity constraints, action types/targets, and v2-specific parameter
constraints. Full validator-backed Draft 2020-12 conformance remains a test
environment limitation; no dependency was installed.

## Action Capability Matrix

| Action | Contract target | Android behavior | Windows behavior |
| --- | --- | --- | --- |
| `open_url` | `android_local` or `windows_host` | For explicit `android_local`, validate HTTP(S) then invoke the OS browser intent. For `windows_host`, dispatch only through an authenticated, current session. | Open only the configured URL through the default browser after host policy/registry checks. |
| `application` | `windows_host` only | Never run locally; show host-only and unavailable unless paired/current. | Resolve the configured absolute executable, validate it, launch without shell/arguments. |
| `run_command` | `windows_host` only | Optional confirmation per `settings.confirm_commands`; send action identity/reference, never the definition as executable instructions. | Resolve the saved command in the current published catalogue; require enabled action and command; validate and execute the fixed step allowlist in order. |
| `keyboard_shortcut` | `windows_host` only | Never inject locally; send configured shortcut reference/chord to host. | Validate saved/inline shortcut and use the existing allowlisted Windows input handler. |
| `system_control` | `windows_host` only | Never change Android system controls; show host availability. | Execute only the five fixed controls, with explicit unsupported display result. |
| `system_monitor` | `windows_host`, read-only | Render only Windows telemetry; never send `action.execute`. GPU/temperature remain unavailable. | Publish bounded CPU/RAM telemetry; preserve unsupported sensor messages. |
| `wait` | Command-step only | No standalone button action and no local command execution. | Bounded delay inside an enabled saved command only. |

`enabled_for_execution` and `confirm_commands` are configuration/UI intent, not authorization. Before host dispatch, Android requires `ready` (paired, authenticated, version-negotiated, and reconciled to the current host epoch/revision). Windows independently validates device authorization/revocation, current epoch/revision, button-to-action assignment, exact published action/command/shortcut data, registry parameters, host policy, and request deduplication. Imported data cannot make an arbitrary command executable.

## Protocol Decisions and Required Changes

The v2 protocol schema/spec now define strict envelopes, exact version
negotiation, pairing status, snapshots, closed typed delta operations,
durability acknowledgement, host action outcomes/status queries, telemetry,
and message bounds. **None of the v2 protocol or gateway behavior is
implemented.** The present v1 WebSocket accepts only `client.ping`; its REST
action route resolves a stored action ID per request. Keep those v1 behaviors
loopback-only.

Contract decisions:

- **Pair/auth/revoke:** Use a separate, explicitly enabled Windows WSS gateway with only v2 allowlisted operations; do not proxy FastAPI routes. Pairing claim is the only unauthenticated application operation, over TLS after server identity verification; code is short-lived/single-use/rate-limited. Windows approval is explicit. Pending devices have no config/action rights. Send the generated credential once over that trusted TLS session, retain only a verifier on Windows, protect it in Android app-private Keystore-backed storage, exclude it from backup/logs, and recheck/revoke active sessions. No LAN listener is enabled by this phase.
- **Server identity:** Bootstrap the WSS endpoint and certificate identity through a Windows-displayed QR/manual verified fingerprint. Android rejects untrusted/self-signed certificates by default; pin rotation/recovery requires explicit Windows confirmation and a documented backup pin. Discovery (manual host or mDNS) is advisory only; no credential is sent until TLS identity is verified.
- **Versions:** `client.hello` advertises supported protocol/configuration versions and authenticated device identity. `config.sync` is the sole revision claim. Unsupported versions fail closed; there is no silent downgrade or v1 reinterpretation.
- **Configuration:** Persist `server_id`, `config_epoch`, and revision on Windows. Send a complete snapshot initially/recovery; apply only contiguous same-epoch deltas to a candidate copy, validate the entire result, atomically persist, then acknowledge. Deltas use only named entity operations for deck, profiles/pages/buttons, actions, commands, shortcuts, and settings; arbitrary JSON Patch paths are forbidden. On mismatch/gap, retain last good snapshot and require a full snapshot.
- **Windows actions:** `windowsAction` includes `run_command` with only `{command_id}`. Windows resolves the saved command in the current published configuration and runs only the registered ordered steps `open_url`, `keyboard_shortcut`, and bounded `wait`. Nested commands, monitors, Android-local targets, shell strings, scripts, and client-provided command bodies are not executable.
- **Action status/idempotency:** `action.execute.message_id` is the idempotency key scoped to authenticated device ID. Persist acceptance/in-progress before side effects; same-key duplicates never execute twice and conflicting payload reuse returns `idempotency_conflict`. `action.result` distinguishes `succeeded`, `failed`, and `unknown`; failed/unknown carry stable codes. `action.status.query`/`action.status.result` retrieves prior state. Keep ledger records at least 24 hours; expired or unprovable results remain unknown. Clients never automatically replay an uncertain action.
- **Telemetry:** Authenticated allowlisted subscribe/update/unsubscribe messages expose only Windows CPU and physical RAM values currently produced by `WindowsSystemMetrics`. Streams bind to epoch/revision, use a 2.5–60 second interval, and expire after at most three intervals. GPU utilization and CPU/GPU temperatures are explicitly `unavailable/unsupported`. Telemetry is read-only and separate from action execution.
- **Errors/reconnect:** Keep 4 MiB config and 16 KiB non-config message caps, enforce limits before JSON parsing and entity/semantic limits after parsing, reject unknown fields/types, and never coerce JSON types. On stale action revisions reject without execution; reconnect with bounded exponential backoff/jitter, reauthenticate, negotiate, reconcile, then enable host actions. Offline local actions may continue; uncertain Windows actions remain unknown.

Remaining implementation blockers are the Windows v2 server/gateway, durable
epoch/config publication and typed delta generation, action ledger/status
storage, telemetry stream lifecycle, WSS trust/certificate operations, and
runtime JSON Schema validation. This phase only updates contracts, fixtures,
tests, and documentation; it does not enable LAN access.

Gateway security boundary: keep `backend/desktop.py`/FastAPI binding at `127.0.0.1`. A later gateway may call narrow internal domain services, but must not bind the current REST app to `0.0.0.0`, tunnel its admin token, expose generic configuration PUT/action REST, weaken Origin/CSP checks, or accept shell text, executable paths, scripts, or Android intents from the phone.

## Import, Export, and Synchronization

- Windows exports a validated v2 JSON configuration only; no admin token, device ID credential, pairing code, TLS private key, or Android secret is exported. V1 export/import passes through the same explicit migration before v2 acceptance.
- Android imports with the system document picker. Parse with strict size/type limits; identify schema version explicitly; validate plus migrate in memory; atomically write a candidate app-private snapshot; switch active state only after commit. Any failure retains the old snapshot byte-for-byte.
- Mark imported state `unreconciled` in local metadata. It may be displayed and explicitly-declared local actions may use the validated snapshot, but host-targeted actions remain disabled. A subsequent authenticated session always reconciles against Windows; accept a delta only with a known epoch/revision, otherwise receive a full host snapshot. If host configuration differs, host wins. Enable host actions only after committed host state matches the current `server_id/config_epoch/revision`.
- Future live sync publishes edits from Windows as contiguous deltas and uses full snapshots for first setup/recovery. Export remains a credential-free backup, not a substitute for authentication or the revision protocol. Device-local profile/page selection never creates a shared revision.

## Android Project and API Compatibility

Minimal future project (not created in this phase):

```text
android/
  settings.gradle.kts
  build.gradle.kts
  gradle/libs.versions.toml
  app/
    src/main/AndroidManifest.xml
    src/main/java/com/pocketdeck/android/
      app/                 # application and lifecycle wiring
      config/              # v2 models, schema/semantic validation
      migration/           # deterministic v1-to-v2 converter
      storage/             # atomic snapshot, Keystore credential store
      selection/           # local profile/page selection
      pairing/             # claim, approval wait, revoke/logout
      protocol/            # envelopes, version negotiation, state machine
      transport/wifi/      # pinned WSS adapter
      actions/local/       # narrow Android action registry
      actions/host/        # Windows dispatch/status client
      telemetry/           # read-only Windows metrics subscription
      ui/                  # Compose deck and connection states
    src/test/               # schema/migration/protocol/storage unit tests
    src/androidTest/        # Keystore, document picker, persistence, UI tests
```

API assessment checked 2026-10-11: Android 4.0 is API 14; API 4 is Android 1.6. The Android Keystore provider starts at API 18, but API 23 is the recommended product floor for modern app-private AES key protection and avoids legacy key-wrapping paths. Current Compose setup supports API 21+, so API 23 is compatible. Hardware-backed Keystore/StrongBox availability varies by device and is not promised. Use platform TLS with strict certificate/hostname validation; no trust-all manager. Current Android Gradle Plugin 9.4 lists Gradle 9.6, Build Tools 36, and JDK 17. The workspace check found no installed/detectable JDK, Gradle, Android SDK, or ADB; no Android build can currently be claimed.

References: [Android API 14 / Android 4.0](https://developer.android.com/about/versions/android-4.0), [Android API 18 / Android 4.3 and Keystore](https://developer.android.com/about/versions/android-4.3), [Keystore security](https://developer.android.com/privacy-and-security/keystore), [Compose setup/API floor](https://developer.android.com/develop/ui/compose/setup), [TLS guidance](https://developer.android.com/privacy-and-security/security-ssl), [AGP compatibility](https://developer.android.com/build/releases/gradle-plugin), and [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android).

## Sequence, Tests, and Acceptance

1. Land and validate the v2 config/protocol schema amendments and fixtures before any client UI. Keep v1 examples and runtime tests unchanged.
2. **Implemented:** pure deterministic v1 migration in `backend/app/config/migration.py`, with focused coverage for IDs/order/assignments, defaults, references, command order, shortcut normalization, monitor restrictions, malformed input, and failure preservation. The caller still owns persistence of its stable UUID namespace and atomic publication of the returned candidate.
3. Define Windows v2 storage/revision epoch and compatibility cutover; retain v1 endpoints and source files until an explicit migration acceptance.
4. Implement authenticated WSS gateway and pairing/revocation only after certificate trust, lifecycle, firewall/enable controls, and action policy receive security review. No LAN exposure before this gate.
5. Implement Android validation/import/atomic storage and protocol state machine; test API 23 and the current Android version. Then add Compose deck UI, connection/availability states, accessibility, and local selection persistence.
6. Add WSS integration tests for cert rejection/rotation, auth/revocation, negotiation, message limits, sync/recovery, at-most-once host actions, unknown outcomes, and telemetry scope. Keep current v1 backend suite as regression gate.

Acceptance criteria: exact v1-to-v2 preservation for all representable values; deterministic stable IDs and repeatable conversion; unsupported or malformed input fails without changing source or active snapshot; Android never executes host-only behavior locally; imports never authorize a host action; Windows validates every remote action against the authenticated device and current published revision; ambiguous action outcomes are visible and never automatically replayed; current loopback API remains loopback-only; no cloud service, Android UI, dependency installation, or LAN listener is added by this architecture phase.

Open questions before runtime: choose and review the Windows WSS certificate issuance/rotation and QR trust recovery procedure; decide whether mDNS discovery is needed for v1 Wi-Fi setup or manual host entry suffices; assign ownership for atomic v1-to-v2 Windows cutover and compatibility lifetime; specify export filename/document UX; and confirm telemetry sample rate. USB-C hardware roles and authenticated USB channel remain deferred.
