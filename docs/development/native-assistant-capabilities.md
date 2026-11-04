# Native Assistant capability map — OpenCode 1.19.5

The React Assistant and runtime recipes use the pinned OpenCode 1.19.5 contract below. The 1.18.16 adapter remains available for historical consumers. Installation-specific release qualification uses the current source-bound gate described in the build guide; an older deployment is not upgraded merely by reading this document.

## Source contract

- Approved scope (2026-11-04): the pinned formal TUI/v1 conversation capabilities. The independent experimental v2 conversation mode is explicitly **unsupported**, not a pending item for this change and not counted as implemented. Existing verified raw-file, canonical PTY and read-only activity interfaces remain supported; an API path prefix alone does not identify a conversation mode. Local scope completion is not publication, appliance deployment or release qualification.
- Upstream: https://github.com/anomalyco/opencode/tree/v1.19.5
- Commit: `810c0eba1a7348036f8bdf61e6632d0c36c6876c`.
- API source: `packages/sdk/openapi.json`; SHA-256 `d224c1a7506ae981c8d4fc1a8d1f58ac185e27324f94d4daf1b8f84fc2552d26`.
- Official ARM64 archive: `opencode-linux-arm64.tar.gz`; published SHA-256 `fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b`. The archive checksum and execution in an isolated local container were verified.
- Upstream license: MIT. API inventory is derived from the pinned native contract. No upstream GUI source, Solid package, or UI SDK is included. The client uses browser fetch/EventSource, product-owned React components and the MIT-licensed xterm packages listed below.
- The official binary has its own upstream TUI/bundled assets. Disabling the embedded Web UI is required; it is not served or used as the product frontend. A future engine-only source build must not silently change the approved release identity.

## Compatibility with 1.18.16

The old bridge protocol remains available for existing history and callers. The native transport forwards request bodies and SSE frames without converting them to platform runs or retrying a lost prompt. The supported product entry points and upstream limitations are listed below; the API inventory is not a claim that every endpoint is a separate supported feature.

Source comparison of upstream migration directories found no change under `packages/opencode/migration`; one change under `packages/core/src/database/migration/20260410174513_workspace-name.ts` handles an existing workspace table without a name column. Local Docker acceptance now verifies synthetic 1.18.16 sessions, files, commands and Skills reopening in 1.19.5, independent user volumes, and recreation with retained state. A real native synthetic model/MCP call, once permission, managed/user configuration merge and PTY output through the product transport also passed. This does not establish in-place downgrade safety, full React acceptance or appliance deployment. Do not downgrade an upgraded database in place or change existing box data for this work.

The React terminal uses framework-independent `@xterm/xterm` 6.0.0 and
`@xterm/addon-fit` 0.11.0 (MIT), pinned in the pnpm lockfile. Neither introduces
Solid or OpenCode GUI packages. Its CSS and notices are local bundled assets.
The older `compatibility-evidence.v1.json` is historical 1.18.16 evidence, not
proof for 1.19.5. The current public qualification entry point is
`python3 tools/validate_opencode_compatibility_gate.py`: it reads the current
engine lock and checks the matching native contract, adapter, recipes and policy.
Source consistency alone does not accept a deployment. Release qualification
additionally requires an external, source-bound ARM64 upgrade summary; see
[the build guide](native-assistant-build.md). Historical passed evidence is not
rewritten or imported as proof for this frontend.

The native v1 path used by the pinned TUI accepts follow-up input while a run is active. Its queued hint is a projection of messages after an unfinished assistant response, not a separate mutable queue. React now presents that same history-derived hint. The pinned TUI message actions and HTTP session routes do not expose cancellation of a single pending input; Stop interrupts the session. The separate experimental v2 routes have explicit queue/steer admission semantics and different state/configuration. They are **not implemented as a React conversation mode** and must not be counted as v1 parity or simulated by a platform queue. Native session export/import uses the pinned CLI format: export reads full native records, import invokes the bundled CLI through native canonical PTY with direct argv and retained exit status. There is no invented HTTP import endpoint. Browser upload is not part of that import dialog; the file must already exist in the user's workspace.

### Verified native limitations

- Session sharing has been discontinued in this release. `packages/opencode/src/share/session.ts` makes `share` fail unconditionally; `unshare` only clears a locally retained link. These compatibility endpoints are not an available public-sharing service. The React UI does not offer a broken share action or substitute a product sharing backend.
- Project `PATCH /config` writes `config.json` (`packages/opencode/src/config/config.ts`, pinned `update`), while `ConfigPaths.files("opencode", ...)` loads `opencode.json`/`opencode.jsonc`. A real 200 response did not make the submitted command effective. React now edits the actual source using native `vcs.apply`, followed by an explicit idle-instance reload and effective-config read. Native Git requirements and conflicts remain enforced. The pinned Config schema is compiled ahead of time for form validation, not replaced with a product config engine. JSONC source/comments stay intact. Global extension configuration retains its separate native save path.
- `GET /find/symbol` returns an empty array unconditionally in this pinned handler. The product does not claim functional symbol search on that basis.
- Legacy PTY lookup returns 404 after process exit. Native CLI import therefore uses `/api/pty`, unwraps its `{location,data}` response, and reads the retained exit code; it does not infer success from a closed socket.
- Native `/experimental/worktree` lists sandbox directory strings, not the internal Worktree service's richer object array. The React list uses those native paths; reset/delete recheck current membership, exclude the primary/current workspace and require explicit typed-name confirmation. Native reset removes untracked files and can run project startup commands.

### Final local reconciliation and remaining delivery boundary

The endpoint table is checked against all 188 pinned operation IDs, methods and
paths. It is an API inventory, not 188 independent user features or 188 passing
runtime tests. Duplicate compatibility endpoints may share an accepted product
operation; a route being reachable never counts as working UI.

The formal v1 conversation path has local React/native evidence for input and
follow-up, attachments, model/Agent/command selection, history, permissions,
questions, tool/subsession/todo detail, files, diffs, terminal, settings,
extensions, usage/compaction and owner isolation. Later controls also cover
owner-wide search/pagination and archived-history opening, runtime paths,
byte-exact raw-patch download and individual history edits. Search does not
implement a new session index; native cursors/order and their limits are retained.

The following boundaries remain explicit:

- **Unimplemented experimental v2 conversation mode:** separate session/event
  store, delivery semantics and configuration/policy path. Native v2 shell,
  Skill, compact and wait methods explicitly raise OperationUnavailableError.
  A React mode for the functioning remainder is outside the user-confirmed
  scope and is not supported. Do not
  silently mix it with v1 messages, weaken managed model policy, or implement
  missing upstream execution inside the product. Background-subagent promotion
  likewise requires a native flag currently reported false. External console,
  workspace/control-plane and desktop TUI administration remain blocked.
- **Release/deployment qualification:** the historical compatibility-gate/evidence
  files bind 1.18.16 and must not be relabelled as 1.19.5 proof. The current public
  validator uses `compatibility-gate.v2.json` and the engine lock, not a private
  helper or historical receipt. Its default result explicitly reports source
  consistency only. `--require-release --evidence PATH` also requires matching
  source and image identities plus actual ARM64 upgrade observations. Raw
  acceptance records and credentials are not part of the source release.

This is not a claim that every experimental API is integrated or that a new
appliance release has been qualified. Experimental v2 is an explicitly
unsupported mode, not an unfinished task in the user-confirmed formal-TUI
scope. Release qualification and deployment remain separate future work;
already-passed unchanged v1 checks are not repeated to close this scope.

## Product boundaries and evidence

- Authentication/CSRF and per-user instance resolution: platform native API tests with synthetic login and wrong-owner routes.
- HTTP/SSE: transport tests preserve bodies/frames, reject path escapes/control-plane requests/redirects, and make exactly one send on uncertain failure.
- Idle reclamation: native sessions, terminals, permissions and questions augment legacy prompt rows. Unknown activity conservatively prevents idle stop; account disable still stops the instance.
- Production App uses the product-owned React Assistant. Its authenticated route, deep-link refresh, legacy-history continuation, native MCP calls/permissions, OAuth popup, files and PTY have local integration evidence. This is not a claim of complete UI coverage.
- The production lifecycle controller/runtime and full image entrypoint have isolated two-owner reuse, ownership, activity and replacement checks. Native MCP OAuth reconnects after replacement; files, sessions, Skills and configuration persist. Small-machine acceptance uses explicitly synthetic capacity telemetry, not a physical host capacity claim.
- Public affected-image builds and offline resource/startup checks have passed; see the [build guide](native-assistant-build.md). Session transfer, projects/worktrees, cross-user integration and the final formal-TUI capability reconciliation have local native evidence. The user-confirmed local scope is complete; the independent experimental v2 mode remains unsupported. Later frontend additions are production-built locally; earlier container-image digests are not claimed to contain those additions. No appliance deployment or new release qualification has been performed for this change.
- Do not count synthetic transport tests or TypeScript checks as native/container acceptance. Runtime evidence belongs in the local implementation record, not this source contract.

## Complete pinned endpoint inventory

Each operation below comes from the pinned OpenAPI snapshot. “Pending” is deliberate: routing an endpoint alone does not complete its UI, permissions, or acceptance. All relevant product controls must be checked against real native results; desktop-only/external prerequisites must be shown honestly. HTTP verbs, paths and operation IDs are also machine-readable in `services/agent-bridge/opencode-native-contract.json`.

| Native operation | Method and path | Category | React entry / handling | State |
| --- | --- | --- | --- | --- |
| `auth.set` | `PUT /auth/{providerID}` | Extensions / authentication | React Settings, MCP and Provider controls | React API-key save/remove and owner-only native credential storage verified |
| `auth.remove` | `DELETE /auth/{providerID}` | Extensions / authentication | React Settings, MCP and Provider controls | React API-key save/remove and owner-only native credential storage verified |
| `app.log` | `POST /log` | Service lifecycle | Controlled installation, not browser administration | blocked at transport |
| `experimental.controlPlane.moveSession` | `POST /experimental/control-plane/move-session` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `global.health` | `GET /global/health` | Configuration / discovery | React Engine status | real native version/status matches displayed data |
| `global.event` | `GET /global/event` | Conversation | React uses workspace-scoped `/event` | accepted native message/status events use the scoped feed; no duplicate all-instance event viewer |
| `global.config.get` | `GET /global/config` | Configuration / discovery | React settings and native JSON editor | native user settings and invalid-draft retention verified; dedicated MCP/Agent/command/plugin/instruction controls also accepted |
| `global.config.update` | `PATCH /global/config` | Configuration / discovery | React settings and native JSON editor | real native save, selector refresh, retained model/provider and independent owner verified; workspace config uses source editing instead of broken project PATCH |
| `global.dispose` | `POST /global/dispose` | Service lifecycle | Controlled installation, not browser administration | blocked at transport |
| `global.upgrade` | `POST /global/upgrade` | Service lifecycle | Controlled installation, not browser administration | blocked at transport |
| `event.subscribe` | `GET /event` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `config.get` | `GET /config` | Configuration / discovery | React workspace and settings panels | production React native effective-model selection and usage/compaction verified |
| `config.update` | `PATCH /config` | Configuration / discovery | React source-file editor uses `vcs.apply` instead | broken native filename path is deliberately not invoked; actual JSON/JSONC save/reload accepted |
| `config.providers` | `GET /config/providers` | Configuration / discovery | React workspace and settings panels | production React native selector loading and extension changes verified |
| `experimental.capabilities.get` | `GET /experimental/capabilities` | Configuration / discovery | React Tools and resources | actual native flag display verified; false backgroundSubagents is not presented as ready |
| `experimental.console.get` | `GET /experimental/console` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.console.listOrgs` | `GET /experimental/console/orgs` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.console.switchOrg` | `POST /experimental/console/switch` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `tool.list` | `GET /experimental/tool` | Configuration / discovery | React Tools and resources | actual selected-model/default-Agent names, descriptions and parameter schemas verified |
| `tool.ids` | `GET /experimental/tool/ids` | Configuration / discovery | covered by richer `tool.list` catalog | no separate duplicate IDs-only UI; not an additional execution capability |
| `worktree.list` | `GET /experimental/worktree` | Configuration / discovery | React Projects / Git worktrees | actual native list, create/open/reload verified |
| `worktree.create` | `POST /experimental/worktree` | Configuration / discovery | React Projects / Git worktrees | actual native branch and directory creation verified in disposable project |
| `worktree.remove` | `DELETE /experimental/worktree` | Configuration / discovery | React typed-name confirmation | cancellation and actual native directory/branch removal verified; primary and other owner preserved |
| `worktree.reset` | `POST /experimental/worktree/reset` | Configuration / discovery | React typed-name confirmation | actual native default-branch reset and untracked-file removal verified in disposable copy |
| `experimental.session.list` | `GET /experimental/session` | Conversation discovery | React Find conversations | real owner-wide title search, cursor pagination, directory filter, archived discovery and deep-link reload verified |
| `experimental.session.background` | `POST /experimental/session/{sessionID}/background` | Experimental | Tools and resources shows native capability flag | selected runtime reports backgroundSubagents=false; no promote button or working-background claim; requires native flag and separate acceptance |
| `experimental.resource.list` | `GET /experimental/resource` | Configuration / discovery | React Tools and resources | actual native MCP discovery/metadata verified with owner-only synthetic resource; not a resource-content fetcher |
| `find.text` | `GET /find` | Workspace / files | React Files / Search file contents | actual native line match and opening result verified; upstream limit ten |
| `find.files` | `GET /find/file` | Workspace / files | React Files / Find files | actual native filename search and opening result verified |
| `find.symbols` | `GET /find/symbol` | Workspace / files | no misleading empty search control | upstream stub returns []; not a functioning symbol-search capability |
| `file.list` | `GET /file` | Workspace / files | React Files, search and diff panel | production React file browser and raw-byte edit baseline verified |
| `file.read` | `GET /file/content` | Workspace / files | React Files, search and diff panel | production React file browser and raw-byte edit baseline verified |
| `file.status` | `GET /file/status` | Workspace / files | React Git changes uses native `vcs.status` | equivalent changed-file listing is accepted through the richer VCS path; this legacy endpoint is not separately called |
| `instance.dispose` | `POST /instance/dispose` | Configuration / discovery | React Reload workspace settings | actual native reload, effective command refresh and active-terminal refusal verified |
| `path.get` | `GET /path` | Configuration / discovery | React Engine status / Runtime paths | displayed paths equal real owner-container native values |
| `vcs.get` | `GET /vcs` | Workspace / files | React Files / Git changes | actual branch/default-branch display verified |
| `vcs.status` | `GET /vcs/status` | Workspace / files | React Files / Git changes | actual changed and untracked files, refresh and independent owner verified |
| `vcs.diff` | `GET /vcs/diff` | Workspace / files | React Files / Git changes | actual working-tree and default-branch patches match native results; no mutation |
| `vcs.diff.raw` | `GET /vcs/diff/raw` | Workspace / files | React Git changes / Download patch | actual downloaded patch bytes equal native response; source files unchanged |
| `vcs.apply` | `POST /vcs/apply` | Workspace / files | React Files and workspace configuration editor | raw text editing, new config file, retained JSONC and conflicting-edit rejection verified; per-message revert is verified separately |
| `command.list` | `GET /command` | Configuration / discovery | React workspace and settings panels | production React native selector loading and extension changes verified |
| `app.agents` | `GET /agent` | Configuration / discovery | React workspace and settings panels | production React native selector loading and extension changes verified |
| `app.skills` | `GET /skill` | Configuration / discovery | React Skills list, description and command selection | native loading and production React execution verified, including missing-tool output |
| `lsp.status` | `GET /lsp` | Configuration / discovery | React Engine status | displayed native status verified; no language-server installation claimed |
| `formatter.status` | `GET /formatter` | Configuration / discovery | React Engine status | displayed native status verified; no formatter installation claimed |
| `mcp.status` | `GET /mcp` | Extensions / authentication | React Settings, MCP and Provider controls | production React connection, refresh, disable and separate-owner config verified |
| `mcp.add` | `POST /mcp` | Extensions / authentication | React MCP form saves native persistent global configuration | adding/discovering/executing accepted via persistent config; transient add endpoint is not used |
| `mcp.auth.start` | `POST /mcp/{name}/auth` | Extensions / authentication | React Settings sign-in popup | production React native discovery/PKCE verified with local synthetic OAuth |
| `mcp.auth.remove` | `DELETE /mcp/{name}/auth` | Extensions / authentication | React MCP Disconnect account | actual browser click removes native credential; reload remains disconnected and other owner is unchanged |
| `mcp.auth.callback` | `POST /mcp/{name}/auth/callback` | Extensions / authentication | same-origin return to initiating React client | native PKCE exchange and callback-window closure verified; sign-out/state unit gates passed |
| `mcp.auth.authenticate` | `POST /mcp/{name}/auth/authenticate` | Extensions / authentication | browser uses native auth start/callback | accepted browser OAuth path instead of container-side browser launcher |
| `mcp.connect` | `POST /mcp/{name}/connect` | Extensions / authentication | React MCP enabled setting persists and reloads native connection | persisted enable/discovery accepted; no separate transient-connect button |
| `mcp.disconnect` | `POST /mcp/{name}/disconnect` | Extensions / authentication | React MCP Disconnect account | actual browser revoke/disconnect and reload verified with synthetic OAuth |
| `project.list` | `GET /project` | Configuration / discovery | React Projects | actual owner-scoped native project metadata verified |
| `project.current` | `GET /project/current` | Configuration / discovery | React Projects | selected native project and reload verified |
| `project.initGit` | `POST /project/git/init` | Configuration / discovery | React Projects / Initialize Git | explicit confirmation, actual Git repository and retained existing file verified |
| `project.update` | `PATCH /project/{projectID}` | Configuration / discovery | React Projects / Project name | actual native rename verified; other owner unchanged |
| `project.directories` | `GET /project/{projectID}/directories` | Configuration / discovery | React Projects / directory buttons | native known directories and selected-workspace refresh verified |
| `experimental.projectCopy.generateName` | `POST /experimental/project/{projectID}/copy/generate-name` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `pty.shells` | `GET /pty/shells` | Terminal | React Terminal / Shell | native acceptable-shell list, exact selected executable, real keyboard output and terminal removal verified; default leaves native selection unchanged |
| `pty.list` | `GET /pty` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
| `pty.create` | `POST /pty` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
| `pty.get` | `GET /pty/{ptyID}` | Terminal | React Terminal metadata comes from native list | individual active lookup not needed by current UI; legacy exited lookup is not retained |
| `pty.update` | `PUT /pty/{ptyID}` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
| `pty.remove` | `DELETE /pty/{ptyID}` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
| `pty.connectToken` | `POST /pty/{ptyID}/connect-token` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
| `question.list` | `GET /question` | Native interactions | Inline React permission/question cards | production React native approval/rejection/question IDs, keyboard answer, refresh and cancellation verified |
| `question.reply` | `POST /question/{requestID}/reply` | Native interactions | Inline React permission/question cards | production React native approval/rejection/question IDs, keyboard answer, refresh and cancellation verified |
| `question.reject` | `POST /question/{requestID}/reject` | Native interactions | Inline React permission/question cards | production React native approval/rejection/question IDs, keyboard answer, refresh and cancellation verified |
| `permission.list` | `GET /permission` | Native interactions | Inline React permission/question cards | production React native approval/rejection/question IDs, keyboard answer, refresh and cancellation verified |
| `permission.reply` | `POST /permission/{requestID}/reply` | Native interactions | Inline React permission/question cards | production React native approval/rejection/question IDs, keyboard answer, refresh and cancellation verified |
| `provider.list` | `GET /provider` | Extensions / authentication | React Settings, MCP and Provider controls | native discovery, code and automatic OAuth verified with synthetic provider; real external accounts not exercised |
| `provider.auth` | `GET /provider/auth` | Extensions / authentication | React Settings, MCP and Provider controls | native discovery, code and automatic OAuth verified with synthetic provider; real external accounts not exercised |
| `provider.oauth.authorize` | `POST /provider/{providerID}/oauth/authorize` | Extensions / authentication | React Settings, MCP and Provider controls | native discovery, code and automatic OAuth verified with synthetic provider; real external accounts not exercised |
| `provider.oauth.callback` | `POST /provider/{providerID}/oauth/callback` | Extensions / authentication | React Settings, MCP and Provider controls | React native generated-code and automatic callbacks verified; real external provider authorization remains external |
| `session.list` | `GET /session` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.create` | `POST /session` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.status` | `GET /session/status` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.get` | `GET /session/{sessionID}` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.delete` | `DELETE /session/{sessionID}` | Conversation | React sessions, messages, tool details and recovery | production React selected deletion and retained original history verified |
| `session.update` | `PATCH /session/{sessionID}` | Conversation | React sessions, messages, tool details and recovery | production React rename verified |
| `session.children` | `GET /session/{sessionID}/children` | Conversation | React sessions, messages, tool details and recovery | actual native task tool, todo updates and child history navigation verified |
| `session.todo` | `GET /session/{sessionID}/todo` | Conversation | React sessions, messages, tool details and recovery | actual native task tool, todo updates and child history navigation verified |
| `session.diff` | `GET /session/{sessionID}/diff` | Conversation | React sessions, messages, tool details and recovery | production React per-turn native diff and revert/unrevert verified against actual file bytes |
| `session.messages` | `GET /session/{sessionID}/message` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.prompt` | `POST /session/{sessionID}/message` | Conversation | React uses native asynchronous prompt and events | real send/history accepted through prompt_async; no duplicate synchronous-send control |
| `session.message` | `GET /session/{sessionID}/message/{messageID}` | Conversation | React Edit message checks current record | actual stale-write refusal and retained draft verified; best-effort preflight, not atomic compare-and-swap |
| `session.deleteMessage` | `DELETE /session/{sessionID}/message/{messageID}` | Conversation | React Edit message / Delete message | cancellation, confirmed deletion, retained other messages and active-run disabled control verified |
| `session.fork` | `POST /session/{sessionID}/fork` | Conversation | React sessions, messages, tool details and recovery | production React independent fork with copied native history verified |
| `session.abort` | `POST /session/{sessionID}/abort` | Conversation | React sessions, messages, tool details and recovery | production React stop verified against running native session |
| `session.init` | `POST /session/{sessionID}/init` | Conversation | React native command selector includes init | pinned handler delegates to the same native init command; no additional execution engine or duplicate control; init-specific generated-file acceptance not claimed |
| `session.share` | `POST /session/{sessionID}/share` | Conversation | no public-sharing button | upstream discontinued; pinned implementation always fails, not a pending working feature |
| `session.unshare` | `DELETE /session/{sessionID}/share` | Conversation | no public-sharing service | compatibility cleanup clears only a local old link; no remote revocation guarantee or React cleanup action claimed |
| `session.summarize` | `POST /session/{sessionID}/summarize` | Conversation | React sessions, messages, tool details and recovery | production React native effective-model selection and usage/compaction verified |
| `session.prompt_async` | `POST /session/{sessionID}/prompt_async` | Conversation | React sessions, messages, tool details and recovery | production React native send/history/reconnect verified; lost accepted receipt causes no automatic resend |
| `session.command` | `POST /session/{sessionID}/command` | Conversation | React command/Skill selector | actual native command and production React Skill send verified |
| `session.shell` | `POST /session/{sessionID}/shell` | Conversation | React Shell command | actual command output in same native history, owner isolation, no model/prompt invocation and explicit Stop verified |
| `session.revert` | `POST /session/{sessionID}/revert` | Conversation | React sessions, messages, tool details and recovery | production React per-turn native diff and revert/unrevert verified against actual file bytes |
| `session.unrevert` | `POST /session/{sessionID}/unrevert` | Conversation | React sessions, messages, tool details and recovery | production React per-turn native diff and revert/unrevert verified against actual file bytes |
| `permission.respond` | `POST /session/{sessionID}/permissions/{permissionID}` | Native interactions | Inline React permission cards use `/permission/{requestID}/reply` | pinned compatibility handler delegates to the same native permission service; accepted reply path avoids duplicate UI |
| `part.delete` | `DELETE /session/{sessionID}/message/{messageID}/part/{partID}` | Conversation history | React Edit message / Delete part | confirmed deletion and cancellation verified; other parts and message metadata retained; no prompt replay |
| `part.update` | `PATCH /session/{sessionID}/message/{messageID}/part/{partID}` | Conversation history | React Edit message / Text | native text edit preserves IDs and other metadata; changed-record preflight refuses stale overwrite and retains draft |
| `sync.start` | `POST /sync/start` | Upstream synchronization | Review native sync authorization before exposure | blocked at transport |
| `sync.replay` | `POST /sync/replay` | Upstream synchronization | Review native sync authorization before exposure | blocked at transport |
| `sync.steal` | `POST /sync/steal` | Upstream synchronization | Review native sync authorization before exposure | blocked at transport |
| `sync.history.list` | `POST /sync/history` | Upstream synchronization | Review native sync authorization before exposure | blocked at transport |
| `tui.appendPrompt` | `POST /tui/append-prompt` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.openHelp` | `POST /tui/open-help` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.openSessions` | `POST /tui/open-sessions` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.openThemes` | `POST /tui/open-themes` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.openModels` | `POST /tui/open-models` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.submitPrompt` | `POST /tui/submit-prompt` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.clearPrompt` | `POST /tui/clear-prompt` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.executeCommand` | `POST /tui/execute-command` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.showToast` | `POST /tui/show-toast` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.publish` | `POST /tui/publish` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.selectSession` | `POST /tui/select-session` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.control.next` | `GET /tui/control/next` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `tui.control.response` | `POST /tui/control/response` | Desktop/TUI only | React equivalents tracked separately | not proxied |
| `experimental.workspace.adapter.list` | `GET /experimental/workspace/adapter` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.list` | `GET /experimental/workspace` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.create` | `POST /experimental/workspace` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.syncList` | `POST /experimental/workspace/sync-list` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.status` | `GET /experimental/workspace/status` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.remove` | `DELETE /experimental/workspace/{id}` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `experimental.workspace.warp` | `POST /experimental/workspace/warp` | Experimental / external control plane | Prerequisites and user-scoped routing review | blocked at transport |
| `v2.health.get` | `GET /api/health` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.location.get` | `GET /api/location` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.agent.list` | `GET /api/agent` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.list` | `GET /api/session` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.create` | `POST /api/session` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.active` | `GET /api/session/active` | Native v2 lifecycle | Read-only native activity during idle reconciliation | actual held v2 run prevents idle reclamation; this does not enable v2 conversations in React |
| `v2.session.get` | `GET /api/session/{sessionID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.switchAgent` | `POST /api/session/{sessionID}/agent` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.switchModel` | `POST /api/session/{sessionID}/model` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.prompt` | `POST /api/session/{sessionID}/prompt` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.compact` | `POST /api/session/{sessionID}/compact` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.wait` | `POST /api/session/{sessionID}/wait` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.revert.stage` | `POST /api/session/{sessionID}/revert/stage` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.revert.clear` | `POST /api/session/{sessionID}/revert/clear` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.revert.commit` | `POST /api/session/{sessionID}/revert/commit` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.context` | `GET /api/session/{sessionID}/context` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.history` | `GET /api/session/{sessionID}/history` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.events` | `GET /api/session/{sessionID}/event` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.interrupt` | `POST /api/session/{sessionID}/interrupt` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.message` | `GET /api/session/{sessionID}/message/{messageID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.messages` | `GET /api/session/{sessionID}/message` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.model.list` | `GET /api/model` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.provider.list` | `GET /api/provider` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.provider.get` | `GET /api/provider/{providerID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.list` | `GET /api/integration` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.get` | `GET /api/integration/{integrationID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.connect.key` | `POST /api/integration/{integrationID}/connect/key` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.connect.oauth` | `POST /api/integration/{integrationID}/connect/oauth` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.attempt.status` | `GET /api/integration/attempt/{attemptID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.attempt.cancel` | `DELETE /api/integration/attempt/{attemptID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.integration.attempt.complete` | `POST /api/integration/attempt/{attemptID}/complete` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.credential.update` | `PATCH /api/credential/{credentialID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.credential.remove` | `DELETE /api/credential/{credentialID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.permission.request.list` | `GET /api/permission/request` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.permission.saved.list` | `GET /api/permission/saved` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.permission.saved.remove` | `DELETE /api/permission/saved/{id}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.permission.create` | `POST /api/session/{sessionID}/permission` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.permission.list` | `GET /api/session/{sessionID}/permission` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.permission.get` | `GET /api/session/{sessionID}/permission/{requestID}` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.permission.reply` | `POST /api/session/{sessionID}/permission/{requestID}/reply` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.fs.read` | `GET /api/fs/read/*` | Workspace / files | React Files, search and diff panel | production React file browser and raw-byte edit baseline verified |
| `v2.fs.list` | `GET /api/fs/list` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.fs.find` | `GET /api/fs/find` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.command.list` | `GET /api/command` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.skill.list` | `GET /api/skill` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.event.subscribe` | `GET /api/event` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.pty.list` | `GET /api/pty` | Terminal | Import / export native CLI result | native retained exited PTY/exitCode verified |
| `v2.pty.create` | `POST /api/pty` | Terminal | Import / export native CLI execution | direct argv native import preserved full messages without prompt replay |
| `v2.pty.get` | `GET /api/pty/{ptyID}` | Terminal | Import / export native CLI result | canonical envelope and retained exit result verified |
| `v2.pty.update` | `PUT /api/pty/{ptyID}` | Terminal | React native CLI terminal | viewport update shares canonical PTY; independent resize acceptance remains unclaimed |
| `v2.pty.remove` | `DELETE /api/pty/{ptyID}` | Terminal | React End terminal uses shared native legacy DELETE | canonical DELETE not independently exercised; canonical import terminal WebSocket is accepted |
| `v2.pty.connectToken` | `POST /api/pty/{ptyID}/connect-token` | Terminal | React native CLI terminal | canonical ticket envelope connected during real import |
| `v2.pty.connect` | `GET /api/pty/{ptyID}/connect` | Terminal | React native CLI terminal | actual import terminal connected; full existing legacy terminal checks are separate |
| `v2.question.request.list` | `GET /api/question/request` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.question.list` | `GET /api/session/{sessionID}/question` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.question.reply` | `POST /api/session/{sessionID}/question/{requestID}/reply` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.session.question.reject` | `POST /api/session/{sessionID}/question/{requestID}/reject` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.reference.list` | `GET /api/reference` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.projectCopy.create` | `POST /experimental/project/{projectID}/copy` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.projectCopy.remove` | `DELETE /experimental/project/{projectID}/copy` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `v2.projectCopy.refresh` | `POST /experimental/project/{projectID}/copy/refresh` | Experimental native v2 | Separate v2 state/config path; not enabled in React | Not implemented in React; v1 controls are not proof for this distinct API |
| `pty.connect` | `GET /pty/{ptyID}/connect` | Terminal | React Terminal panel | production React native terminal input, resizing, end and same-PTY reconnect verified |
