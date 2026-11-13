# Project handbook

This is the maintenance entry point for Team AI Box. Installation and user guides
remain in the [documentation index](../README.md); this handbook is for development.

| Document | Purpose |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | Instructions Codex reads when working in this repository |
| [Requirements](REQUIREMENTS.md) | Current product boundaries and links to detailed contracts |
| [Conventions](CONVENTIONS.md) | Development, verification, documentation and publication rules |
| [Decisions](DECISIONS.md) | Approved changes in direction and what they supersede |
| [Change record](CHANGELOG.md) | Sanitized maintenance changes, separate from release claims |
| [Retired validation](legacy-validation.md) | Historical tooling that must not drive new work |

## One plan, ordinary documents

Use Codex's built-in conversation planning for execution, not a separate planning
framework. Persist enough context in a Markdown plan to resume across sessions.
For private maintainer work, the single entry point is `.project-local/PLAN.md`.
For public collaboration, use an issue, PR or a sanitized Markdown plan. Other
contributors do not need Codex or private documents to build or contribute.

A useful plan records:

1. The user outcome and authorized scope, including what must not change.
2. Concrete steps and their acceptance criteria, ordered by dependencies.
3. The current step, completed evidence, unresolved failure and next action.
4. Changes in direction and a clear distinction between implementation,
   verification and release.

Do not duplicate the same task list in several proposal/design/spec files.
Small fixes need only a short plan in the conversation and an appropriate change
record. Continue approved work without an extra approval ceremony for each step.
Never infer permission to deploy, publish, interrupt services or destroy data
from a plan.

## Local historical material

The previous OpenSpec workspace has been retired. Its original files, hashes and
old checklists are retained under the ignored `.project-local/history/` directory.
Detailed migrated requirements and the current Penpot plan also remain local;
they were not automatically reclassified as public source. The local index maps
their provenance and the approved decisions that override older wording.

OpenSpec commands, skills, synchronization and archival steps are not part of this
project's workflow. Historical evidence proves only its original scope, not a
new release. Do not reopen completed tests merely to change planning tools.

Start Codex in the active product checkout so it loads the repository's
`AGENTS.md`; an archived checkout cannot inherit another checkout's instructions.
This follows the official [Codex project-instructions convention](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Keep publication boundaries intact

Only reviewed, sanitized maintenance documents belong in this public repository.
Private plans, raw evidence, host details, credentials and historical working
notes remain ignored. The private website is maintained separately. A clean
clone must not need `.project-local/` or the retired OpenSpec files at runtime,
during a source build, or to understand contribution requirements.
