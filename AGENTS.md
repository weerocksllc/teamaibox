# Team AI Box — project instructions

## Start here

- Read `docs/project/README.md`, then the relevant architecture, API or installation document. Use this checkout, not an archived checkout or the private website repository.
- If `.project-local/PLAN.md` exists, read it before continuing maintainer work. It is a local handoff, not a dependency for public contributors or source builds.
- Inspect the worktree before editing. Preserve unrelated changes, user data and existing delivery tags.

## Planning and progress

- Use Codex's built-in planning during the conversation. For multi-step work, keep the goal, scope, acceptance criteria, current step and next action in an ordinary Markdown plan; use `.project-local/PLAN.md` for private maintainer work and an issue/PR or sanitized document for public collaboration.
- This project no longer uses OpenSpec. Do not invoke its commands or skills, create its artifacts, or require proposal/spec-sync/archive steps. Retired material is historical reference only.
- Keep one current plan. Do not create another task framework, scheduler or background automation to advance a checklist. Do not restart completed steps just because a conversation resumed.
- Distinguish planned, implemented, verified in a stated environment, and released. A build, healthy container or marked checkbox alone is not end-to-end acceptance.
- Record the actual change, narrow verification, remaining gap and next action after meaningful progress. If a failure is unchanged, investigate its cause instead of rerunning it unchanged. Reuse passing evidence unless its inputs or affected path changed.
- Continue authorized work without repeatedly asking to proceed. Ask only for missing authority, a consequential undecided choice, or a genuine external blocker. A plan does not grant permission to publish, deploy, interrupt services or delete data.

## Product and engineering boundaries

- The product is a source-deployed team workspace for DGX Spark. Source deployment is the primary delivery path; appliance/offline packaging is optional. Do not claim an independent source deployment flow exists before it is implemented and verified.
- The AI assistant is a React interface to native OpenCode, with a per-user container and necessary platform isolation. Reuse native sessions, MCP, Skills and execution; do not introduce a second Agent/MCP engine or the upstream Solid GUI. Upstream patches must be explicitly approved, minimal, pinned and documented.
- Keep existing users, conversations, MCP entries, Skills, models, guest disks and files intact. Unknown write outcomes require reconciliation, not replay of a prompt or write operation.
- Use current permissions at access boundaries. Do not bypass origin, download, ownership or revocation checks to make a test pass.
- Default to English until the user explicitly chooses a display language. Preserve that selection and theme across login and applications; follow `packages/ui-system/src/locale-registry.mjs` for supported locales.
- Do not restore cross-application pre-reserved CPU/RAM/codec/network admission quotas. Actual pressure safeguards, ownership, storage limits and fair scheduling are separate concerns.
- Keep product-facing copy useful to users; put acceptance notes, reasoning and implementation caveats in maintainer records instead.

## Development and verification

- Toolchain versions come from `package.json` and lockfiles; build instructions are in `docs/open-source/BUILDING.md` and `install/SOURCE-INSTALL.md`.
- Run only checks affected by the change. For documentation-only work, validate changed links, generated translations and distribution exclusions; do not rerun device, model or application acceptance.
- Use isolated synthetic fixtures. Never reset Docker, reinstall a host, restart unrelated services or clear shared caches without explicit scoped authorization.
- Historical OpenSpec-dependent release runners are retired; see `docs/project/legacy-validation.md`. Do not bypass their checks to manufacture a passing historical report.

## Publication and records

- Product code and the private marketing website are separate repositories. Do not copy website sources, private history, credentials, account traces, original logs/screenshots, models, images or installation packages into this public source tree.
- `.project-local/` and retired `openspec/` paths remain excluded from Git, source exports and build contexts. Never force-add them. Public development must not depend on those files.
- Update the relevant stable document when behavior changes, `docs/project/DECISIONS.md` when an approved rule changes, and `docs/project/CHANGELOG.md` with a sanitized change summary. Do not copy internal evidence into public product documentation.
- Commit, push, deployment, website publication and tag changes each require authorization covering that action. Do not infer them from a request to organize documentation.
