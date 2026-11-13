# Current product requirements

These are maintenance boundaries, not a claim that every integration or deployment
has passed acceptance. The [decisions](DECISIONS.md) resolve older conflicting
wording; the current plan records remaining implementation and verification.

## Product and source deployment

- Team AI Box is an open-source team workspace designed for NVIDIA DGX Spark.
  Public source must be buildable without developer-box configuration, private
  images, maintainer accounts or signed-in guest disks.
- Source deployment is the primary user path. Keep preparation, model acquisition,
  image builds and startup understandable and resumable. Verify pinned origins
  and checksums; retry the failed stage without discarding successful artifacts.
- Offline/appliance packages remain optional delivery artifacts. An unexecuted
  original whole-appliance installation is not a substitute for, or automatic
  blocker of, source-deployment acceptance. Do not claim either path is verified
  solely because its component containers run.
- Current implementation details and safe commands are in
  [source installation](../../install/SOURCE-INSTALL.md) and
  [build guidance](../open-source/BUILDING.md). The
  [independent Design profile](../../install/DESIGN-SOURCE.md) starts its own
  services without the package installer and is for maintenance. The normal
  Team AI Box source path invokes its installer internally and includes Design,
  available under **All apps** with the same platform account and assistant.

## Interface and AI assistant

- Default display language is English. An explicit user choice persists across
  refresh, login and applications. Keep language and theme consistent; use the
  [locale registry](../../packages/ui-system/src/locale-registry.mjs).
- The assistant is a React interface to native OpenCode, in a separate persistent
  container per user. Reuse native sessions, permissions, MCP, Skills, project
  files, terminals and execution rather than maintaining a second Agent engine.
- Do not embed the upstream Solid Web GUI. Approved minimal native transport
  patches must be version-pinned, separately identified and reproducible. Do not
  label modified artifacts as unmodified upstream binaries.
- Supported conversations follow the approved formal TUI/v1 capability map;
  the independent experimental v2 session interface remains unsupported.
- Preserve existing user sessions, MCP/Skills configuration, model selection and
  files. Scope tooling to current permissions and targets; an unknown write
  result is reconciled, never automatically replayed.
- See [capabilities](../development/native-assistant-capabilities.md),
  [interactions](../development/native-assistant-interactions.md),
  [storage](../development/native-assistant-storage.md) and
  [extensions](../development/native-assistant-extensions.md).

## Penpot integration boundary

The approved integration remains in progress, not a released-feature claim:

- Build Penpot and its official MCP/plugin from pinned source. Reuse native
  editing and the existing React assistant panel, not a replacement design or
  MCP execution engine.
- AI collaborates with an explicitly connected, open editor. Do not add hidden
  background browsers or promise editing after the page is closed.
- Platform identity, team membership and current file rights protect manual
  editing, collaboration, exports, downloads and MCP calls. Revocation must not
  delete user designs or permit stale links to bypass authorization.
- Team Drive imports/exports use explicit source versions and saved design
  versions. Unknown receipts are resolved against the original operation; do not
  create duplicate files or replay a design modification.
- Verify source deployment, persistent data, safe upgrades and the actual browser
  flows separately. See [integration development](../../install/PENPOT-DEVELOPMENT.md).

## Data, operations and application boundaries

- Preserve existing accounts, files, model assets, virtual disks and recovery
  state. Schema changes require explicit migrations; never rewrite applied
  migration history or clear data to hide a failed upgrade.
- Application readiness is independent. Dependencies recovering late must allow
  the affected service to resume without restarting unrelated applications or
  flushing compilation caches.
- Do not restore aggregate pre-reserved CPU/RAM/codec/network admission quotas.
  Actual pressure/OOM safeguards, bounded concurrency, lease ownership, fencing
  and user storage limits remain separate safety mechanisms.
- No USB-key dependency or external-backup product requirement is reintroduced.
  Account recovery, trash and upgrade rollback are distinct functions.
- Virtual computer operating systems are user-installed from supplied media.
  Do not redistribute installed proprietary guests or login traces.

## Detailed contract map

| Area | Maintained references |
| --- | --- |
| Modules and ownership | [Module catalog](../../architecture/module-catalog.json), [boundaries](../architecture/module-boundaries.md) |
| Authorization and data | [Authorization](../architecture/authorization-model.md), [storage](../architecture/production-storage-layout.md), [security](../security/end-to-end-threat-model.md) |
| Collaboration and files | [User guide](../operations/user-guide.md), [artifact handoffs](../architecture/scoped-artifact-handoffs.md) |
| Plugins | [Plugin API](../api/plugin-api-v1.md), [isolation](../architecture/plugin-sandbox-and-isolation.md), [locale/theme SDK](../architecture/plugin-locale-theme-sdk.md) |
| Compute and models | [Compute API](../api/compute-api-v1.md), [memory pressure](../architecture/unified-memory-pressure-and-oom-safeguards.md), [model lifecycle](../operations/model-certification-guide.md) |
| Runtime and maintenance | [Health](../architecture/runtime-health-and-exclusive-maintenance.md), [updates](../architecture/platform-update-and-host-maintenance.md), [restart](../operations/controlled-restart-qualification.md) |
| Virtual devices and casting | [Phones](../operations/virtual-phone-camera.md), [computers](../virtual-computers-user-guide.md), [installation media](../virtual-computer-installation-api.md), [casting](../operations/wireless-casting-guide.md) |
| Source distribution | [Release scope](../open-source/RELEASING.md), [privacy](../open-source/SOURCE-PRIVACY.md), [licenses](../../THIRD_PARTY_NOTICES.md) |

Older historical documents are not permission to revive superseded features.
If source behavior and this handbook disagree, record the discrepancy and fix
only within the approved scope; do not silently report compliance.
