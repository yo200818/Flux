# Shared definitions

Contains versioned JSON configuration and protocol definitions shared by the
Windows host and clients. Version 1 of the configuration schema is at
[`schemas/v1/config.schema.json`](./schemas/v1/config.schema.json), with a
small example at [`examples/config.v1.json`](./examples/config.v1.json).

The format covers profiles with pages, configurable grids, ordered buttons,
and references to typed actions with JSON parameters. The optional v1
`commands`, `shortcuts`, and `settings` fields add versioned saved Windows
command definitions, reusable validated keyboard chords, and application
preferences without changing `schema_version` or activating the v2 runtime.
Website actions continue to use the stable `open_url` action type and URL
parameter; an optional `name` parameter provides a reusable friendly name.
Older configurations without that field remain valid and retain their
existing action IDs.
The `application` and `system_control` action types add, respectively, a
user-selected Windows executable path and one of five fixed Windows volume or
display-brightness operations. Application paths are launched directly without
a shell, but remain trusted user-level programs; brightness is available only
when Windows and the display driver expose a controllable monitor API.
The read-only `system_monitor` action type may be assigned to a button as a
widget, but must keep `enabled_for_execution` false and is rejected by the
action execution endpoint. The Windows v1 backend reports CPU utilization from
system counter deltas and memory usage from native Windows APIs. GPU and
temperature metrics remain explicitly unavailable unless a trustworthy sensor
provider is added; configuration does not imply that a metric is supported.
Commands run only when an enabled `run_command` action assigned to a button
references the saved definition. Their steps are validated by the action
registry and cannot contain nested commands or shell/code execution.

Keep transport-specific details out of shared configuration so future clients
can use the same protocol. Backend-side validation also enforces cross-object
rules such as globally unique IDs, action/command/shortcut references, and
grid capacity; these rules are called out in the schema because standard JSON
Schema cannot express all of them across nested objects.
