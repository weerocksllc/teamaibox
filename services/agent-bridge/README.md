# Agent Bridge

Stable platform-owned Agent session, prompt idempotency, ordered event cursor,
workspace/sandbox identity, operation-confirmation, and recovery boundary.
Version adapters call unmodified, digest-pinned OpenCode network services.

## Current native Assistant

The React Assistant uses the pinned OpenCode 1.19.5 native TUI/v1 conversation
contract through authenticated owner-scoped HTTP, SSE, file and PTY transport.
OpenCode owns sessions, execution, tools, permissions/questions, MCP and Skills.
Each user has an independent persistent non-root engine container. The product
does not embed the upstream GUI or add another Agent/MCP execution service.
Experimental v2 conversations are unsupported.

The current public release check is:

```sh
python3 tools/validate_opencode_compatibility_gate.py
python3 tools/validate_opencode_compatibility_gate.py --require-release --evidence /path/to/current-private-summary.json
```

The first command checks current source/configuration consistency and explicitly
reports `releaseAccepted: false`. The second also requires actual source-bound
ARM64 upgrade observations and exact image identities. It reads
`architecture/opencode/compatibility-gate.v2.json` and the current upstream lock;
it never imports old private validation helpers or accepts historical 1.18.16
receipts. Keep runtime summaries, credentials, prompts and logs outside Git.
The v1 gate/evidence files and old exact-run validators are historical records,
not the current release path. See [native capabilities](../../docs/development/native-assistant-capabilities.md)
and [build instructions](../../docs/development/native-assistant-build.md).

## Retained legacy Bridge contract

The following describes the older platform-run protocol retained for historical
callers. Its restrictions and historical receipts are not the current native
Assistant feature contract.

Browsers and plugins never connect to OpenCode directly. This repository does
not copy or patch upstream OpenCode source.

The first compatibility adapter is locked by
`architecture/opencode/upstream-lock.v1.json`. It speaks only networked
`opencode serve`, requires per-sandbox HTTP Basic credentials, preserves SSE
order within a connection, rejects version drift, and never calls upgrade,
public-share, provider-authorization, or unrestricted configuration routes.
The historical `architecture/opencode/compatibility-gate.v1.json` bound the
upstream tree and ARM64 artifact to the adapter, registry, hardening policy,
capability contract, and passing evidence. Any pinned-version change must
use current version-bound qualification rather than relabel the old receipt.

Platform conversation bindings, prompt request digests, acceptance boundaries,
event cursors, terminal outcomes, and crash reconciliation are repository
contracts with both in-memory test and PostgreSQL implementations. Prompt text
is not stored in Agent Bridge metadata. A transport failure after submission is
marked reconciliation-required; it is never blindly replayed.

Agent sandboxes have a durable one-per-user identity and owner-derived named
workspace volume. The Bridge policy fixes non-root UID/GID, read-only root,
builtin seccomp, dropped capabilities, CPU/memory/PID/open-file/tmpfs and
workspace quotas, gateway-only networking, and no devices. Node Agent repeats
the checks and verifies trusted volume labels for the exact owner, sandbox, and
disk quota before Docker create. On-demand lifecycle counts durable operations;
an idle stop preserves the workspace volume.

OpenCode receives only the platform OpenAI-compatible provider, approved model
aliases, and a short-lived sandbox-bound credential projected into tmpfs. Each
sandbox runs OpenCode in pure mode with project configuration, default/external
plugins and skills, model metadata fetching, embedded Web UI, auto-update and
public sharing disabled. Its generated configuration is root-owned, read-only,
and projected below an ephemeral root-owned runtime directory so user code
cannot replace it through the persistent workspace. Each
sandbox start also projects native Pip, NPM and APT client files that target
the internal Source Gateway. General Internet destinations remain a separate
administrator allowlist and do not change package routing.

Tool permissions pass through a durable operation-confirmation state machine.
The policy may allow read-only work, deny forbidden host capabilities, or
pause an exact action scope for the initiating user's authenticated decision.
Approvals use OpenCode's one-shot reply only; `always` is forbidden. Decisions,
timeouts and interruptions are revision-fenced and audited without command
contents. A crash or unknown reply after approval becomes
`reconcile_required`; manual reconciliation records observed reality and
never resends the approval.

The executable Agent safety matrix covers per-user isolation, host-escape
controls, bounded quota pressure, internal-only offline package routing,
Internet denial, reconnect/replay, Bridge restart, OpenCode crash recovery,
approval/interruption races, authenticated interruption, and uncertain side
effects. The matrix points to exact test names so coverage cannot be claimed by
an unrelated passing test.
