# Atomic plugin lifecycle

OpenSpec task: `6.3`

## Blue/green state model

Plugin install and upgrade use `blue`/`green` runtime slots. A verified import
is staged through the Node Agent, migrations are prepared against the plugin's
retained data namespace, the staged container starts, and all declared probes
must produce at least three consecutive healthy observations. Until those gates
pass, the old version and old slot remain the database's current route.

`activateVersion` locks the plugin row and changes current version, active slot,
lifecycle state, version health, slot state, generation, and operation stage in
one PostgreSQL transaction. The gateway can therefore route from the durable
current-version/slot pointer without a split-brain side channel. Only after
cutover and migration-session commit does the Node Agent promote the new slot;
the old runtime is retired last. A retirement failure is recorded for
reconciliation and does not roll back a healthy active version.

Before or during cutover, a startup, health, migration, or promotion failure
rolls back the migration session, stops/removes the staged runtime, marks its
version and slot failed, restores the prior current version/slot when necessary,
and closes the idempotent lifecycle operation with a bounded error code.

## Administrative operations

- Install, upgrade, enable, disable, and uninstall require `plugin:manage`.
- Every mutation uses a bounded idempotency key and per-plugin serialization.
- Enable starts the current slot and re-runs the consecutive-health gate; a
  failure stops it and keeps the plugin disabled.
- Disable is committed only after the Node Agent stops the active runtime.
- Uninstall removes runtime state with `retainData: true`; it cannot request data
  purge, and migration history remains durable.
- A protected plugin is recognized only when it is official, published by
  `teamaibox`, and explicitly marked protected. It cannot be disabled or
  uninstalled, and upgrades must remain official and publisher-consistent.

The plugin runtime never controls Docker directly; every stage/start/stop/
promote/retire/remove action is a Node Agent command.

## Persistence

Migration 17 adds plugin generations, active slots, retained data namespaces,
verified-import linkage and version health timestamps, plus:

- `plugins.lifecycle_operations` for idempotency, stage, result, and failure;
- `plugins.runtime_slots` for blue/green version and health state;
- `plugins.migration_runs` for ordered running/applied/committed/rolled-back/
  failed evidence.

The down migration removes only lifecycle metadata added by migration 17; the
normal uninstall path never invokes it and never deletes plugin data.
