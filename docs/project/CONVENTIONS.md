# Development and documentation conventions

## Changes and verification

- Keep changes focused and preserve unrelated worktree edits. Inspect before
  replacing files, restarting a service or cleaning temporary resources.
- Use versions from package manifests and lockfiles. Pin upstream inputs and
  document patches rather than silently swapping distributions or frameworks.
- Use isolated synthetic data for checks. A passing build is compilation
  evidence; acceptance must exercise the relevant user operation, persistence
  and authorization boundary in the stated environment.
- Reuse unchanged passing evidence. A failure needs a specific diagnosis and
  bounded correction, not an unchanged loop or complete rebuild from scratch.
- Keep raw logs, screenshots, temporary accounts and machine-specific evidence
  outside public source. Record a concise sanitized result and its scope.
- Do not mark an unverified path complete. Record blocked work separately from
  work explicitly deferred by the user; neither is a pass.

## Documentation ownership

| Information | Maintain it here |
| --- | --- |
| User-facing product introduction | README locale sources and generated README editions |
| Supported commands and user operations | `install/`, `docs/operations/`, application guides |
| Architecture and API contracts | `architecture/`, `docs/architecture/`, `docs/api/` |
| Stable contributor/agent agreements | `AGENTS.md` and this handbook |
| Approved direction changes | [Decision record](DECISIONS.md) |
| Current task, remaining work and continuation | One Markdown plan; `.project-local/PLAN.md` for private maintainer work |
| Sanitized maintenance changes | [Change record](CHANGELOG.md); commits/tags identify actual releases |
| Historical raw planning/evidence pointers | Ignored `.project-local/history/`, never public changelogs |

Edit a statement at its owning source and link to it elsewhere. Do not create
parallel proposal, design and spec documents that repeat the same acceptance
list. Keep detailed design notes only when they explain a real architectural
decision or tricky interface.

## Languages and generated documents

Follow [CONTRIBUTING](../../CONTRIBUTING.md). README prose lives in
`docs/readme-locales/` and `docs/readme-features/`. Translated guide paragraphs are
keyed from their source text in `docs/document-locales/`; update those keys and
regenerate the affected editions. Do not hand-edit a translated output and let
the next render restore obsolete wording. Preserve language-aware navigation.

Internal maintenance records may use the working language. Product documentation
and interface changes must respect the existing localization contract. Do not
describe acceptance procedures, tool limitations or internal deliberations as
product marketing copy.

## Release boundaries

Original code is MIT; third-party components retain their own licenses and
corresponding-source requirements. Keep product and private website repositories
separate. Do not upload secrets, user/guest state, models, images, installation
packages, private history or original test evidence. Review
`docs/open-source/release-policy.json` for export exclusions.

No task plan grants deployment or publication authority. Preserve delivery tags
and archived Git history. Historical qualification schemas may remain readable,
but retired runners do not define new release readiness; see
[retired validation](legacy-validation.md).
