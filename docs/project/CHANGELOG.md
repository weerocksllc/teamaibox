# Maintenance change record

This record separates local maintenance work from published releases. Commit and
tag history remains authoritative for released source. Older private working
notes are retained locally; they are not copied into this public log.

## Unreleased — 2026-11-07

- Build the Android SDK and Camera2 APK with Java and zipalign inside a
  dedicated Docker build image, without installing a host Android toolchain.
- Install directly from verified local images and source build assets. Offline
  archives are exported only when explicitly requested.

- Included Penpot in the standard Team AI Box source installation and first-use
  guide. The installer checks the installed editor and MCP routes before catalog
  registration; it does not require a separate Design deployment. A normal
  source install reuses the verified package directory without writing a second
  archive; `--build-only` still produces the portable archive.
- Verify that Docker can actually expose GB10 to a container before installing
  AI workers, rather than requiring a named runtime or assuming CDI is configured.
  Validate the same NVIDIA device request when creating AI workers and retain
  the exact container configuration on recovery. A check without a local probe
  image reports that Docker GPU verification is pending.
- Restore only this installation's containers after its encrypted storage,
  device helper and casting credentials are ready. Fresh source installations
  do not change the shared Docker service unit or its startup dependencies.
- Added a standalone source deployment profile for Design, with pinned image
  preparation/reuse, generated configuration, protected owner setup and a
  data-preserving stop command. It does not install host appliance services.
- Aligned Design catalog permission with its database role grants, and added
  protected object-service readiness for container-only deployments.
- Allowed the native backend to load its compression library from its own
  bounded temporary filesystem during file creation and save.
- Added opt-in Design AI on a dedicated Docker engine: the existing per-user
  OpenCode controller, official Penpot MCP and verified local model.
- Fixed read permissions on the OpenCode image's startup modules and native
  SDK manifests; the image build now checks SDK initialization as its runtime
  user. Added an explicit mirror option for locked Docker Hub build inputs.
- Locked the official Bun and Transformers source-build inputs by checksum.
  Design source builds prefetch and verify the pinned Emscripten archives
  before starting the frontend build.
- Fixed the Design Drive picker's empty destination list and reject truncated
  native design archives before handing them to the importer. Checking an
  uncertain write still reads the original result without resubmitting it.
- Added `design upgrade` and `design rollback` for compatible manual Design
  instances on a dedicated Docker engine. Upgrades open a separate copy of
  the data; rollback starts the original copy and retains candidate changes.
- Extended the compatible Design switch to AI instances. It refuses active
  OpenCode work and carries per-user sessions and MCP settings in separate
  generation-scoped workspaces; rollback restores the original workspaces.

## Unreleased — 2026-11-06

- Replaced the OpenSpec maintenance workflow with Codex project instructions,
  ordinary Markdown planning and a documented ownership map for project docs.
- Consolidated product boundaries, contributor conventions and approved decisions.
- Retained detailed historical requirements, task identities and acceptance
  notes in an ignored local migration archive; preserved incomplete work.
- Updated contributor guidance across all supported document languages.
- Retired historical OpenSpec-dependent command-line qualification entrypoints
  without converting their missing checks into successful release results.
- Strengthened local planning/history exclusions for source distribution.
- Recorded source deployment as the primary path. No installer implementation,
  appliance deployment or application behavior was changed by this migration.

Verification scope: documentation integrity, task/spec coverage, localized
contributor output, archive checksums, private-file exclusion and retired CLI
behavior. No hardware, model, browser or unrelated application tests are part
of this documentation change. This entry does not claim a commit, push or release.
