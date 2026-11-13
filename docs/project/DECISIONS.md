# Decision record

These are approved maintenance decisions. They describe required direction;
they are not a substitute for implementation or acceptance evidence.

## 2026-11-06 — Codex planning replaces OpenSpec

Use Codex's built-in conversation planning, root `AGENTS.md` instructions and
ordinary project documents. Keep one persistent Markdown plan for ongoing work.
Stop using OpenSpec commands, skills, proposal/spec synchronization and archival
ceremonies. Preserve old material privately as historical reference rather than
deleting evidence or publishing it under a new filename.

This supersedes the optional-OpenSpec contributor instruction and the use of old
OpenSpec task counts as a current project status. Previously open tasks remain
open unless the user changes scope or actual evidence closes them.

## 2026-11-06 — Source deployment is the primary path

The open-source user's path starts from a source checkout. Model preparation,
image building and startup must be understandable, independently resumable and
free of developer-box assumptions. Offline and whole-appliance installation are
optional delivery paths, not the definition of completion for every source change.

The full-appliance source command still delegates to the package installer. The
[independent Design profile](../../install/DESIGN-SOURCE.md) uses its own services;
it does not provision all appliance features. The previously unexecuted original whole-host
installation remains unverified and is deferred as an optional gate; it is not
retroactively passed. Existing package and isolated runtime evidence is retained.

## 2026-11-07 — Design is part of the standard product

The standard source installation includes the source-built Penpot editor and
its official MCP. Users open **All applications → Design** after signing in to Team AI
Box. They use the same identity, permissions, Team Drive and per-user OpenCode;
no separate install, Docker engine, or sign-in is required. The standalone
Design profile is a maintainer option, not the product's delivery or acceptance
path. Accept the normal install and browser path separately from component tests.

## Prior approved decisions carried forward

Dates below are intentionally not reconstructed from memory. These rules are
carried forward, not newly introduced by the documentation migration:

- **Assistant:** React front end, native OpenCode engine, per-user containers;
  reuse MCP and Skills. No Solid GUI or parallel Agent/MCP implementation.
  An explicitly approved minimal Penpot transport-context patch is allowed,
  with locked inputs, attribution and a distinct modified artifact identity.
- **Design integration:** source-built Penpot, official MCP/plugin, an open
  editor for interactive AI collaboration; no unattended hidden-browser engine.
- **Preferences:** English by default; explicit language/theme choices persist.
- **Resources:** remove pre-reserved cross-application resource admission quotas;
  keep actual pressure safety, ownership and bounded concurrency protections.
- **Distribution:** product source is public, website source private; preserve
  archived Git history and delivery tags. No private runtime data in releases.
- **Data protection:** no USB key or external-backup product dependency; preserve
  account recovery, trash, upgrade rollback and existing user data.
