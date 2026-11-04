# Native Assistant storage and connections

The Assistant UI is React. OpenCode owns sessions, tool execution, permissions,
questions and extensions. The integration does not contain another MCP client.

## User state

Each authenticated owner is mapped by the existing sandbox controller to one
non-root container. All pages belonging to that owner reuse it. The controller
checks the owner label and volume subpaths before starting or stopping it.

The owner's `/workspace` volume contains:

| Path | Purpose |
| --- | --- |
| `.teamaibox/home` | Native home directory and user-installed tools |
| `.teamaibox/data` | OpenCode sessions and native authentication storage |
| `.teamaibox/config/opencode` | Writable native configuration and Skills |
| `.teamaibox/cache` | User-specific package and runtime caches |
| Project directories | Files, project instructions and project extensions |

Startup only creates missing directories. It does not replace user config or
remove sessions. Container removal is distinct from deleting its workspace.
Never mount one user's native database into two active engine containers.

The Agent sandbox image contains the pinned native extension SDK and its locked
dependencies. First startup seeds them into an empty native configuration
directory, without downloading them or overwriting `opencode.json`, Skills or
an existing user package manifest/lockfile/modules. Existing user-managed package
trees remain under native dependency management. Additional plugin dependencies
are not implicitly bundled or promised to work offline.

## Platform-managed settings

The existing read-only configuration remains at
`/run/teamaibox/xdg-config/opencode/opencode.json`. The image exposes its
directory through `/etc/opencode`, OpenCode's native managed configuration
location. User configuration lives in the writable XDG configuration directory.
OpenCode merges the sources itself; the product does not implement a second
configuration loader. Platform model routing and disabled public sharing remain
managed settings. Saving a user extension must not overwrite this managed file.

Project configuration and user Skills/plugins are no longer blanket-disabled.
They still run as the user inside their container, under existing host, network
and resource restrictions. External dependencies may require network access.
Native credential files are protected by the existing storage/access boundary;
they are not a separately encrypted credential vault.

## Transport

`/api/v1/assistant/native/*` authenticates the product browser session. Mutations
require CSRF; cross-origin reads and WebSocket connections are rejected.
The platform chooses the owner's Bridge; the browser cannot choose an instance
address or supply its internal credentials. The Bridge forwards HTTP/SSE to its
loopback OpenCode instance. Only native PTY connect endpoints can upgrade to
WebSocket. Socket bytes are forwarded without implementing a terminal executor.
Sign-out and periodic authorization checks close established native channels.

An uncertain prompt submission is never retried automatically. Reconnect reads
the same native state; it does not replay historical messages.

The product route is `/apps/assistant`. Its `assistantSession` and
`assistantDirectory` query parameters reopen the selected native session and
workspace after refresh. The authenticated owner is always resolved on the
server, independently of these parameters. The current React input submits
directly to OpenCode, without the old keyword-based answer/Agent routing.

Project navigation and browser drafts are presentation state, keyed by the
authenticated identity, canonical directory and native session (or that
directory's new-conversation view). The first direct-linked selection is
remembered as well as selections made in the sidebar. A different identity in
the same tab clears the previous identity's Assistant URL context before it is
opened. Persisted drafts contain text, selections and attachment metadata;
attachment bytes stay in memory and require reselection after refresh.

`/api/v1/assistant/native/workspace/folders` and `/workspace/files` are product
file operations, not OpenCode endpoints. They keep browser authentication,
same-origin and CSRF checks, then use the current owner's authenticated Bridge
to create a folder or import one ordinary file inside its container. The
Bridge pins directory descriptors, rejects symlink traversal and reserved
runtime paths, and creates files exclusively without overwriting existing
ones. Import limits are 100 selected files per batch and 16 MiB per file;
JSON bodies for these two routes are bounded separately. These operations do
not start prompts, PTYs, Git initialization or platform execution records.

Earlier platform conversations remain under **Earlier conversations**, with
their original messages and artifact links. An existing owner-checked native
binding offers **Continue original conversation**; opening it reads the same
native session without creating a replacement or resending old messages.
History with no native binding remains read-only. The older API is retained
for compatibility and is not the new Assistant's execution path.

File previews use native filesystem bytes for editing: the 1.19.5 legacy JSON
preview trims whitespace and is not a suitable edit baseline. The adapter
binds v2 filesystem requests through the native `x-opencode-directory` header
derived from the validated workspace. Browser-provided location overrides are
rejected. Saves use native `vcs.apply`; conflicting edits are not overwritten.
The runtime image includes Git and ripgrep. File patch editing requires a Git
project; terminal operations still run only in the owner's container.

MCP sign-in opens the provider in a separate window. OpenCode performs discovery,
PKCE and token exchange. `/assistant/oauth/callback` removes its query string
before rendering and returns the native state/code through a short-lived
same-origin browser channel. Only the initiating authenticated client completes
the native callback. Logout cancels that channel. The callback closes its own
window because cross-origin opener isolation may sever the original popup handle.
Neither authorization codes nor instance passwords are kept in browser storage.

The local production-browser harness covers this callback, reloaded connection
state, persisted disabling and a second account's separate configuration. It
uses generated local identities and a synthetic OAuth service; it does not log
in to an external provider or require a real client secret.

## Local compatibility verification

`services/agent-bridge/test/native-container-acceptance.mjs` accepts locally
built image IDs through `NATIVE_PREVIOUS_IMAGE` and `NATIVE_CANDIDATE_IMAGE`.
It creates uniquely labelled synthetic volumes, checks version migration and
independent user state, then removes only its own containers and volumes. It
never pulls images or reads an existing appliance workspace. Passing this check
alone does not establish the complete React interaction acceptance.

`services/agent-bridge/test/native-lifecycle-acceptance.mjs` additionally uses
the production controller, Docker runtime adapter and image entrypoint with
two synthetic owners. It covers concurrent reuse, owner checks, native activity
and state retained across replacement. The runner's isolated Docker networks
have no external access. On small development Docker VMs it explicitly injects
synthetic capacity telemetry; its result is not a hardware capacity benchmark
or evidence that a production memory-admission check passed. The deployed
controller continues to read real host telemetry. Synthetic identity/storage
fixtures do not connect to the platform database.

Do not downgrade an upgraded database in place. Retain a protected pre-upgrade
copy before an engine update; recovering that version and retaining subsequent
data are separate operations. Never discard newer data to claim compatibility.
