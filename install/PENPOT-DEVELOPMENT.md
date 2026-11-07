# Penpot source integration development

This guide describes the Design application built into Team AI Box.
It uses the standard Team AI Box installation and sign-in.

### Standard Team AI Box installation

On a supported fresh DGX Spark, use the normal installation command:

```sh
sudo bash install/from-source.sh
```

Normal source installation uses local image IDs and copies verified assets
directly into the installation. Use `--build-only` to export an offline
package without installing it. The standard build includes pinned
Penpot frontend, backend, exporter and official MCP source builds, the native
OpenCode transport patch, pinned PostgreSQL/Valkey dependencies, the browser
plugin and corresponding source/licenses. It does not copy accounts or files
from a running service. Keep the same workspace when resuming. If you have an
older source workspace that built without Design, use a new `--work-dir` and
retain verified downloads with `--cache-dir`.

To build on a connected supported host and install later on a separate, fresh
DGX Spark, use `sudo bash install/from-source.sh --build-only`.
Transfer the complete generated package directory, not just its install script
or the corresponding-source archive. In that directory, run
`bash ./install.sh --verify-package` to verify the package, then
`sudo bash ./install.sh --check` to check the target. Only on the fresh target
run `sudo bash ./install.sh`. Do not use an alternate installation root to
install alongside a running appliance: the installer also uses host service
registrations and ports. These commands describe the candidate path; a full
disconnected first-use run with the Design package has not yet been verified.

After installation, sign in to Team AI Box at its normal HTTPS address and
choose **All applications → Design**. Do not run the fresh-install command over an
existing installation. The generated configuration creates private networks, distinct target-generated keys and
protected design storage; it exposes no native debug or database ports. The
manual editor does not depend on AI readiness. The complete offline installation
and all end-user design flows remain acceptance gates; six healthy services do
not by themselves prove those flows.

## Move designs and images between Penpot and Team Drive

- Open **Design → Import from Drive**, choose a team folder, then select a file
  and its version. A `.penpot` archive creates a separate editable design in
  the project you choose. PNG, JPEG, and WebP are inserted into the open page.
  Files can be up to 32 MiB. You need read access to the Drive file and edit
  access to the destination. The original Drive file is unchanged. If an
  archive is incomplete, export it again from Penpot before importing.
- To insert a picture from your computer, open a design page and choose
  **Insert local image**. PNG, JPEG, and WebP up to 32 MiB are supported.
- Let Penpot finish saving before choosing **Save to Drive**. For PNG or PDF,
  choose a frame, then name a new file or select an existing file and choose
  **Save as new version**. A name conflict never overwrites the existing file.
  If the design or Drive entry changes before the save, reopen the dialog and
  select the latest version.
- If a transfer result is uncertain, choose **Check result**. This looks up the
  original operation; it does not perform it again.
- PNG/PDF exports are linked to the source design. Downloading or previewing
  them from Drive requires both Drive access and current access to the design,
  even if the file was shared or copied in Drive. Revocation cannot recall
  bytes someone has already downloaded.

## Sources and build

`deploy/penpot-source.lock.json` pins Penpot 2.18.5 to commit `f44566963daf61fce4d8608e7c5e8c27c5853a88`, the complete source archive checksum and selected contract files. The official MCP and browser plugin come from that same commit. The upstream MCP root package still calls itself `2.17.0`; it is not a separate release download. Its plugin API/types dependencies are `1.5.0`, and its workspace dependencies use the included frozen lockfile.

OpenCode remains governed by `architecture/opencode/upstream-lock.v1.json` (1.19.5); do not independently update it while integrating Penpot. The native `tool.execute.before` hook receives sessionID and callID in the actual MCP call chain. It executes before permission confirmation, so an eventual adapter must also check target and permission at dispatch, not just when that hook first runs.

The unmodified pinned runtime does **not** send those identifiers to MCP. Its native transport sends tool name/arguments and a progress token. The integration candidate adds an optional `mcp.tool.dispatch` hook inside the existing native call path, after native permission approval and before the official SDK sends the request. Runtime server/tool/session/message/call IDs are separate from model arguments. Hook rejection or cancellation prevents dispatch; ordinary MCP entries keep their existing behavior. This hook is transport context, **not** an authorization grant.

### OpenCode transport candidate

`deploy/opencode-penpot-transport.lock.json` pins the source commit and complete Git tree. `install/apply_opencode_transport_patch.py` refuses a changed tree, ambiguous patch context or an existing output directory. It verifies the complete tree again after copying, before applying four narrow native-source edits. Existing product binaries, user containers and the original upstream binary lock are not replaced by this preparation step.

```sh
python3 install/apply_opencode_transport_patch.py \
  --source /path/to/exact-opencode-source --output /path/to/new-opencode-candidate
docker build --platform linux/arm64 --target artifact \
  -f install/images/opencode-penpot-source.Dockerfile \
  --output type=local,dest=/path/to/new-opencode-artifact /path/to/new-opencode-candidate
```

The input must be a source-only export of the pinned commit, without `.git`, dependencies or local additions. The build installs Bun 1.4.4 from its SHA-256-pinned ARM64 publisher archive on a digest-pinned base. It uses the native frozen dependency lock, a gateway-only model catalog and upstream's native CLI build. It does not embed the Solid Web GUI. The artifact includes the binary checksum, MIT license and a manifest recording `modifiedByPlatform`, patch revision, upstream tree and modified-file hashes. The native version stays `1.19.5` for SDK compatibility; the separate manifest and binary checksum distinguish this candidate from the official unmodified release.

Transport acceptance covers two concurrent native sessions, post-confirmation target changes, rejection, cancellation, unchanged ordinary MCP calls and exclusion of proof data from native history. It uses a deterministic local model solely for dispatch, not as proof of AI design quality. The protected official Penpot MCP/plugin uses live user/file/connection authorization. Optional source assembly, activation through the product entrypoint and a stopped legacy instance transition are implemented; full appliance installation, offline workflows and Penpot data-schema upgrades remain separate acceptance gates.

### Per-user Agent image and configuration

The source-built native transport is packaged on top of the normal public-source
Agent image. Supply that local base by its immutable image ID and the checksum
of the native artifact you built:

```sh
python3 install/build_penpot_agent.py \
  --base-image sha256:YOUR_LOCAL_AGENT_IMAGE_ID \
  --artifact /path/to/new-opencode-artifact \
  --binary-sha256 YOUR_NATIVE_BINARY_SHA256 \
  --output /path/to/penpot-agent-candidate
```

The builder verifies the upstream commit/tree, current lock and patcher, modified
file set, binary checksum, base architecture and product entrypoint. It uses a
verified local base alias because BuildKit does not interpret bare image IDs in
`FROM` as local references. Builds are locked and content-addressed; no user
container is replaced. The public service builder also accepts
`--penpot-native-artifact` and `--penpot-native-sha256` when building
`--roles agent-sandbox`, and records the final modified image rather than its
unpatched base.

The controller's optional `penpot` configuration contains `enabled`,
`transportRevision: "teamaibox-penpot-transport-2"`, `platformOrigin` and
`mcpOrigin`. Origins identify private services, never a development box address.
The controller projects a private context into the existing owner's read-only
runtime mount and adds only `teamaibox-penpot` and its native dispatch hook to
managed defaults. It does not rewrite the owner's native configuration, Skills
or session database.

The MCP entry targets `http://127.0.0.1:4098/mcp`. This private credential adapter
streams native MCP requests unchanged to the official server and supplies the
purpose-separated owner credential at the HTTP boundary. Native configuration
does not contain a bearer token. The context and existing private key are read
from `/run/teamaibox`; browser requests and arbitrary proxy destinations are
refused. Disabling the context stops new transport requests and existing event
streams without interrupting model requests or deleting user state.

For runtimes with the dispatch hook preloaded, the bridge uses OpenCode's native
MCP add operation once the selected workspace is idle. It leaves active terminals,
tasks and prompts alone, and never disposes the instance or rewrites user config.
Disabling Design blocks its transport immediately. A legacy runtime without the
hook reports `restart_required`; it is not forcibly restarted or silently replaced.
An entry that conflicts with user configuration reports `configuration_conflict`
instead of overwriting it. The `x-teamaibox-design-runtime` response header on the
native MCP listing reports this activation state.

#### Existing Agent instances

Fresh installs omit `penpot.previousAgentImage`. An authorized upgrade of an
existing installation can set this option to the **exact immutable image ID**
of the normal Agent 1.19.5 image used to build the selected Penpot overlay. The
controller does not adopt image tags or arbitrary prior images. It checks the
candidate's base-image provenance and shared database setting before cutover.

- A running old image remains an ordinary Assistant, with no Design credential.
  The editor reports that the workspace needs an update without blocking manual
  design. Do not close a running task or terminal just to enable Design.
- Only after a normal stop and with no outstanding platform work can the next
  provision retain that exact old container as `<owner-container>-before-penpot`
  and start the replacement over the same workspace and private mounts. The
  controller never deletes that container or the data. A failure before create
  can be retried; disabling before any candidate exists restores the stopped
  old name on the next provision. An unrelated name collision is refused.
- Both builds use the same `opencode.db`; the separate source-build channel is
  attribution only, not a separate session store. An earlier unreleased pilot
  that created a channel-specific database is not automatically merged.
- For a controlled rollback after a candidate exists, first stop new admissions
  and obtain permission to stop the selected owner instance after its work ends.
  With the controller quiesced, verify both immutable IDs, owner labels and
  protected mounts; retain the stopped candidate under a separate unused name
  and restore the stopped original's name. Select the prior image and disable
  Design before starting through the controller, so it projects only original
  defaults. Never run both images on the same workspace or remove the volume.
  This path was checked for the exact 1.19.5 image pair, not as a generic downgrade.

Do not use fresh installation to apply this transition to an existing box.
The Agent rollback does not roll back Penpot's independent database or schema.
Do not start an older Penpot backend on a database opened by a newer backend
just to roll back its image. A full Penpot version change needs its own
compatibility check and a verified recovery path for both the database and
design assets. The Agent image procedure above does not provide that path.
The guarded Penpot backend refuses migration when it finds schema steps it
does not recognize. This is a stop condition, not permission to downgrade:
file formats and assets can change without a new database step, and older
images without this guard cannot be relied on to stop. Keep the prior images
and a consistent pre-upgrade copy of the Design database and assets; verify
any restore on a separate target rather than restoring over the live data.
The appliance's generic service replacement tool refuses to replace, resume
or roll back the Penpot backend or PostgreSQL. It would otherwise reuse the
live data mounts. This refusal does not stop the running design service.

In the isolated ARM64 upgrade rehearsal, a design with a PNG created on
Penpot 2.18.4 reopened on the 2.18.5 candidate with the same file, media and
asset contents and permissions. The rollback reopened a separate pre-upgrade
database and asset copy on 2.18.4. This does not provide an appliance-level
upgrade command; do not use the fresh installer or the generic replacement
tool to upgrade an existing Design service.

### Protected MCP authority

`install/apply_penpot_mcp_binding_patch.py` creates a separate overlay of the official MCP server. Its optional private authority callback authenticates one-use call proofs before the existing native tool handler runs. In protected mode, HTTP credentials use the Authorization header, not URL parameters; a transport session cannot be reused with a different credential. Legacy SSE and multi-instance Redis routing are not enabled for this single-box candidate.

`PenpotCallProofs` stores only proof digests, expires unused proofs after 15 seconds and consumes them atomically through its repository. The authority verifies the actual pending/running native call, current platform session, design permission, runtime and selected editor generation. IDs from user configuration are not sufficient. The authority is wired through the platform runtime and migrations 119/120; its private routes require the actual native pending call and current editor binding.

The official MCP overlay checks the live binding again before native plugin dispatch. The authenticated browser consumes a short-lived, single-use receipt bound to the exact native task and code digest. A private proxy credential and per-user route are required for the WebSocket; browser/model code never receives those credentials. Missing authority, stale bindings and unmatched responses fail closed. The official SDK, native tool handlers and bridge remain the execution path. Protected plugin failures set the standard MCP `isError` flag so native OpenCode records an error rather than a successful tool result.

`ProtectedExecuteCode` connects the official handler to Penpot's existing SES compartment. `TargetBoundApi` checks retained handles, methods, callbacks and asynchronous results against the selected editor target. The official helpers use this guarded API; stored native handles can be reused on the same target, while a target-generation change clears storage. The generated compartment has no plugin transport, browser DOM or host-authority capability. This boundary is not another execution engine and cannot roll back operations already dispatched inside a native API. Complete helper/library compatibility and native asynchronous commit fencing remain release requirements.

Platform session/ACL/target repositories and the protected web routes are connected to the official MCP and editor. The factory adds the protected manual-editor catalog route and observes frontend/backend availability separately from AI/export availability. Complete native team-directory enforcement and fresh-install acceptance remain requirements. Deterministic tool-selection fixtures are not evidence of local-model design quality.

For interactive design, open an editable file, select an assistant session
and a model that supports tools, then choose **Connect this design**. Ask for
a small change and check the resulting layers in the editor before asking for
another. You can edit or undo the result with Penpot's normal controls.
Keep the editor open while the assistant is working. If you see **Result needs
review**, choose **Open original design** and check the layers or native history.
When you've checked the change, choose **I checked the result**. This does not rerun the
request or reconnect the assistant. Connect explicitly if you want to continue.
An interruption does not undo a change the editor has already saved.

Review the proposed code in the assistant before choosing **Allow once** or
**Reject**. The Penpot tool can both read and change a design, so this
confirmation applies only to that call and the design that was open when it
was requested. Changing the design or disconnecting invalidates an outstanding
confirmation; it does not replay the action on the new design.

Use a local model and inference template that produce structured tool calls.
An assistant message that describes a change is not proof that it was applied.
For a first design, ask the assistant to create one editable shape, then check
its properties in the Layers or Design panel and wait for Penpot to save.
Rename that layer yourself and ask the assistant to read its current name
before making the next edit. You can check or revert the result in Penpot's
native history.

### Team directory boundary

To enable a shared design workspace, open **Design → Team spaces**, select
your platform team and choose **Enable Design**. Once it is ready, choose
**Open team space** from the Design dashboard. If you have a file open,
save your changes and return to the dashboard first. Team members can open a
workspace once a team administrator enables it; a platform administrator who
is not a member cannot open it. Manage membership in Team AI Box.

If enabling does not return a result, refresh the list before retrying.
Reopening or retrying for the same team does not create another workspace.
Private designs stay in the user's personal space.

Migration 121 stores stable platform-team/native-team identifiers, not design
content. Only an explicit active `team_admin` membership may activate a team
through the Design team endpoint; appliance ownership alone is not membership.
Native provisioning retains an immutable founder and uses Penpot's normal team
and project creation. A private live callback projects roles on demand;
personal spaces, projects and files are not altered by membership withdrawal.
Platform guests are viewers, members/developers are editors and team
administrators are native administrators while their membership remains valid.
An old native file/project owner grant cannot elevate a mapped viewer. Native
controls cannot remove the mapped team or independently edit its membership.
Renaming a user or team does not change the mapping or transfer ownership.
Migration 124 records the native activation acknowledgement separately from
the stable mapping. Existing mappings without an acknowledgement can be
confirmed through the same idempotent activation action; no team or file is
recreated and existing permissions are unchanged.

The protected editor disables anonymous bearer share-link permissions, including
previously issued links, without deleting the source designs. To view a
design, sign into Team AI Box and use an account that has access to that
design. A private server check follows the native team and file actually
subscribed to by each collaboration connection; it closes a revoked stream
without ending the user's Team AI Box session or removing any design.

Manual file operations, collaboration and source export check current native
membership against the directory. Previously generated source archives retain
the original file binding; obtaining a download path does not give a former
member continued access. The derived-format exporter runs on the private design
network and takes its progress recipient from the authenticated editor gateway.
Downloading a previously generated PNG or PDF still requires current access to
its source design. This also applies to versions saved to Team Drive and to
copies made within Team Drive. Revoking access does not delete those entries.

### Version-bound Team Drive exchange

The protected integration routes support a single-file native `.penpot` archive
up to 32 MiB. An import uses an explicit Drive file and version and a selected
Penpot project. It creates an independent editable copy, leaves the Drive
version unchanged, and retains the original file/version and byte digest.
The target team's permissions govern the resulting copy: removing source Drive
access later does not erase a copy that was already validly imported.

Source export requires the saved native file/page revision and document version.
Saving to Drive either creates a uniquely named file or explicitly appends a
version using the selected file's current metadata revision. No same-name
overwrite is automatic. Keep the original operation ID after a timeout and
observe the outcome for that operation; a pending result is not evidence of
failure or rollback. Drive and native Penpot commit receipts are written in the
same transactions as their visible file changes. Rechecking a receipt does not
submit a second write.

The browser picker requests ordinary JSON explicitly for its native team and
project lists. The platform rejects a truncated ZIP envelope before dispatch;
the native importer still validates its manifest and enforces parser limits.
Temporary private output is not automatically removed when the commit outcome
is unknown; cleanup must not delete an object used by a committed version.

The same overlay applies `penpot_svg_target_patch.py` to two checksum-bound native frontend files. Plugin SVG imports capture their original file/page before asynchronous parsing or image upload and check that target again before adding shapes. Protected calls also pass a host-only validity callback into the native import; it rechecks the connection/session generation immediately before insertion. Model-supplied extra arguments cannot replace that callback. Existing manual-import arities remain unchanged. Real delayed-image-upload checks cover both page changes and session-generation changes on the same page, plus successful import without a change. Already uploaded media is not falsely reported as rolled back or deleted. Other native asynchronous APIs and production authority wiring still require their own acceptance.

Call proofs and editor delivery receipts have PostgreSQL repositories with atomic single-use consumption, registered by migration 120. They store digests and bounded-lifetime context, not raw credentials, generated code or results. The standalone database test requires an explicitly supplied isolated empty database and rejects populated databases.

### Native sign-in overlay

`install/apply_penpot_patches.py --source /path/to/verified-source --output /path/to/new-patched-source`
creates a separate, version-checked build tree. It refuses changed input contracts and existing output. It adds one native authentication command and two configuration fields; the platform bridge consumes a 60-second, one-use code and returns a stable native profile ID. Passwords and platform cookies are not forwarded. The overlay also records the exporting profile on native source-file temp objects so Penpot's existing download-owner check applies. Modified upstream files remain MPL-2.0; overlay and patcher hashes accompany the build tree.

Migration 119 and the protected platform routes register the identity mapping and handoff service. Team synchronization and the complete authorization lifecycle remain required before enabling the app. Do not expose the native callback or backend ports to the network.

Use paths outside this checkout for all downloaded sources, logs and build output:

```sh
python3 install/prepare_penpot_source.py --cache /path/to/cache --output /path/to/new-source
python3 install/build_penpot_mcp.py --cache /path/to/cache --output /path/to/new-build
```

The second command builds the original isolated ARM64 MCP pilot without the protected integration overlays. It does not install it, expose ports, register an application or alter existing containers. Failed logs remain in the chosen output directory. An optional `--archive` reuses a downloaded archive only after full pinned verification. Existing output directories are never replaced. Source downloads use the existing resumable cache and reject checksum mismatches.

For the combined identity, native-editor and protected-MCP candidate, use:

```sh
python3 install/build_penpot_stack.py \
  --cache /path/to/penpot-download-cache --output /path/to/penpot-candidate \
  --roles penpot-backend penpot-frontend penpot-exporter penpot-mcp
```

`--prepare-only` verifies the archive and applies the version-bound overlays without invoking Docker. The prepared tree retains the upstream license and source/patch manifests. To resume, run the same command with the same dedicated output directory. A nonblocking build lock prevents duplicate runs; successful images are reused only after architecture, content key and image ID checks. Changed prepared source is rejected rather than silently re-fingerprinted. Failed attempt logs are preserved; a resumed build starts only missing/changed roles. Role keys include relevant source content, executable bits, recipe and architecture, so a plugin change invalidates frontend/MCP, not backend/exporter. This command produces candidates, not a deployment or complete offline installer. OpenCode's separately identified transport artifact above must also be included before runtime activation; the unmodified upstream binary is not a substitute.

The editor build limits the JVM heap to 3 GiB, each Node heap to 1.5 GiB, and Rust/Angular worker parallelism to two jobs. Native bundled plugins build serially rather than launching all Angular builds together. These are compiler-process limits, not runtime reservations or a guarantee that a host with that amount of RAM is sufficient. An approximately 8 GiB Docker VM was insufficient to compile while also keeping the isolated backend running, even with heap limits. Use a build environment with adequate free memory; do not build alongside live user services on such a constrained host. Only explicitly designated disposable test services may be paused for a local build. The builder does not stop containers, change Docker memory allocation or reset data. Interrupted builds can resume from recorded successful stages.

The protected editor keeps native collaboration, rendering pages and exports behind `/api/v1/design/editor/`. Its downloaded source files use the current browser origin and that prefix, retaining the native asset ID and native owner check. The version-bound download overlay is enabled only by the protected gateway; ordinary upstream deployments keep their original URLs. Backend and frontend must mount the same persistent asset store (frontend read-only), so native accelerated downloads can read exports without making the backend public. Do not put this store on a disposable `tmpfs` in an installed appliance.

The dedicated frontend image enforces Penpot's native CSP with the inline script hashes produced by that exact build. It adds `unsafe-eval` for the native SES plugin sandbox, which initializes on page load, and retains the native same-origin resource and frame restrictions. This exception belongs only to the protected design editor response, not the platform shell or other plugins. Do not substitute the platform's generic script policy or disable CSP globally.

The pilot uses the public official Node 24.22.1 ARM64 base pinned by digest, rather than the upstream authenticated `dhi.io` base. It installs the upstream checksum-pinned pnpm 12.15.0 executable. Compatibility, native libraries and runtime resources still require acceptance; a completed image build alone is not sufficient.

`check_penpot_mcp.mjs` runs inside that pilot image with `--network=none`, no host mounts, read-only filesystem and a small ephemeral `/tmp`. It checks actual native tool discovery, sharp PNG encoding/decoding, loopback-only HTTP/WS listeners and absence of the debug REPL. It does not test editor or document authorization and must not be used to claim those pass.

`images/penpot-editor-source.Dockerfile` is a separate ARM64 build pilot. Its `backend-build` target uses upstream's JDK 27.0.0 and Clojure CLI 1.12.5.1664 with verified archive hashes and compiles the common Java classes before the backend jar. `frontend-build` compiles the Rust/WASM renderer, plugin runtime, official MCP browser plugin and ClojureScript editor. Maven/Git dependency caches are exclusive to the Penpot pilot.

The `backend-runtime`, `frontend-runtime` and `exporter-runtime` targets package those source outputs. ImageMagick is compiled from checksum-pinned public source; no prebuilt Penpot application image is used. The candidate uses the build JDK for its backend runtime, public Nginx for HTTP delivery and the upstream Playwright version for the export browser. These targets feed the optional factory installer. Platform login and assistant binding are supplied by the protected integration overlays and platform services, not by an unmodified upstream image. Complete native-team and offline workflow acceptance is still required.

For the verified source directory from the preparation step:

```sh
docker build --platform linux/arm64 --target frontend-runtime \
  -f install/images/penpot-editor-source.Dockerfile -t penpot-frontend-local /path/to/new-source
docker build --platform linux/arm64 --target backend-runtime \
  -f install/images/penpot-editor-source.Dockerfile -t penpot-backend-local /path/to/new-source
docker build --platform linux/arm64 --target exporter-runtime \
  -f install/images/penpot-editor-source.Dockerfile -t penpot-exporter-local /path/to/new-source
```

The pinned source's Nginx startup consumes a CSP hash file that its frontend build does not emit. The recipe derives that file from the exact compiled `index.html`, `rasterizer.html` and `render.html` inline scripts. This candidate enforces the native policy, with the documented SES exception above; it does not disable CSP to make the editor run. Protected embedding and plugin execution remain distinct integration checks.

| Build input | Pinned upstream choice / integration gap |
| --- | --- |
| Node / pnpm | 24.22.1 / 12.15.0; public ARM64 base replaces authenticated `dhi.io` |
| JVM / Clojure CLI | upstream build JDK 27.0.0 / CLI 1.12.5.1664; upstream runtime separately selects JDK 26.0.2.1, so runtime compatibility must be proven |
| Clojure dependencies | exact source manifests retained; frontend dev dependencies containing `RELEASE` still need resolved version pinning before reproducible release acceptance |
| Canvas renderer | Rust 1.91.0, Emscripten 4.0.6, skia-safe 0.93.1 and the pinned source Cargo.lock; upstream downloads a Skia dependency archive, not a prebuilt Penpot editor |
| Media and export | ImageMagick 7.1.2-32 compiled from source, native font tools, Playwright 1.62.1 Chromium; actual media/export and offline font/browser closure remain required |
| Browser plugin URL | standalone MCP pilot defaults to localhost:4402; editor integration must use the protected same-origin route, never publish this default as a working product connection |

## Native capability map

Paths below are relative to the pinned upstream source. They identify implementation surfaces, not completed Team AI Box acceptance.

| Capability | Upstream source |
| --- | --- |
| Projects, files, native persistence | `backend/src/app/rpc/commands/projects.clj`, `files*.clj`; `frontend/src/app/main/data/dashboard*`, `persistence.cljs` |
| Pages, shapes, paths, text and images | `frontend/src/app/main/data/workspace/{pages,shapes,drawing,texts,media}.cljs` and `path/` |
| Components, variants and libraries | `frontend/src/app/main/data/workspace/libraries.cljs`, `variants.cljs`, `assets.cljs` |
| Tokens and Flex/Grid | `frontend/src/app/main/data/workspace/tokens/`, `layout.cljs`, `grid_layout/` |
| Prototypes, comments, inspection | `workspace/interactions.cljs`, `comments.cljs`; `frontend/src/app/main/ui/inspect/` |
| Editable source import/export | `frontend/src/app/worker/import.cljs`, `main/data/exports/files.cljs`; `backend/src/app/rpc/commands/binfile.clj` |
| Rendered PNG/JPEG/WebP/SVG/PDF exports | `frontend/src/app/main/data/exports/assets.cljs`, `wasm.cljs`; independent exporter/runtime dependencies |
| Native identity/session entry points | `backend/src/app/rpc/commands/auth.clj`, `profile.clj`, `backend/src/app/http/session.clj` |
| Official MCP tool execution | `mcp/packages/server/src/tools/`, `PluginBridge.ts`, `PenpotMcpServer.ts`; browser plugin under `mcp/packages/plugin/` |

Do not claim Figma lossless import, editable PDF round-trips or arbitrary file compatibility from this map. Actual format results belong to the affected-path acceptance evidence.

| File category | Source-declared inputs / outputs | Boundary |
| --- | --- | --- |
| Editable design | `.penpot`, native binfile-v1 and zip-manifest binfile-v3 (`penpot/export-files`) | recognized by content, not arbitrary zip or extension; preserved native objects must be verified by round-trip |
| Canvas media | JPEG, PNG, WebP, GIF, SVG (`common/src/app/common/media.cljc`) | preserve upstream SVG/media sanitization; this list does not promise GIF animation editing |
| Fonts | TTF, OTF, WOFF, WOFF2 (same media registry) | custom font permissions and offline packaged font licensing apply |
| Rendered outputs | PNG, JPEG, WebP, SVG, PDF (`exports/assets.cljs`) | derived exports are not a substitute for editable design source |
| Design tokens | native token import/export in workspace tokens | no unsanitized HTML in errors; do not equate JSON token import with arbitrary document import |

## Locale mapping

The product registry remains the authoritative locale list. At this source revision:

| Product | Native Penpot locale |
| --- | --- |
| en, de, es, fr, ko, ru, ar, hi, id, it, tr | same code |
| zh-CN | zh_cn |
| zh-TW | zh_hant |
| ja | ja_jp (translation file `jpn_JP.po`) |
| pt-BR | pt_br |
| th | translation file exists, but not enabled in `supported-locales` |
| vi | no translation file or supported locale entry |

Presence of a community translation is not proof of completeness. Thai needs activation and validation; Vietnamese needs translation and activation. Default English and explicit persisted choices must be applied before editor rendering. RTL must not mirror user canvas content.

## Security and licensing

### Platform identity and protected editor transport

The optional platform runtime reads `PLATFORM_PENPOT_INSTALLATION_ID`,
`PLATFORM_PENPOT_TOKEN_PEPPER_FILE` and `PLATFORM_PENPOT_BACKEND_KEY_FILE`.
The two private files contain independently generated 32-byte base64url secrets;
do not place their contents in source, browser storage or model configuration.
Migration 119 stores stable profile mappings and token hashes, never passwords
or raw native session tokens. It deliberately refuses a destructive downgrade.

`PLATFORM_PENPOT_FRONTEND_ORIGIN` and `PLATFORM_PENPOT_BACKEND_ORIGIN` enable the
dedicated editor transport. They are private operator-configured service origins,
not browser-supplied proxy targets. POST `/api/v1/design/enter` requires the
existing platform session, CSRF token and same-origin checks. Its returned
editor path is `/api/v1/design/editor/`; native cookies are scoped, Secure and
HttpOnly, and bound to the platform session that obtained them. An unrelated
account or expired platform session cannot reuse one. Native Penpot still checks
project and file permissions; platform administration is not content ownership.

The native backend's private handoff callback must target
`/internal/v1/design/login-handoff` on the platform API and use the matching
service key. The integration overlay pins this callback to HTTP/1.1: the
platform's upgrade handler is for WebSockets, not Java HTTP-client h2c negotiation.
Do not expose that callback or backend directly on the LAN. The public web
boundary forwards `/api/`, not this internal route.

The native frontend runtime does not resolve or proxy external GitHub template
and Google-font endpoints at startup. Those optional endpoints return 404;
the appliance's bundled/custom fonts remain local. This avoids an external DNS
dependency but does not establish a complete offline font/export closure by
itself. The source build checks that the frontend has its renderer WASM and
bundled fonts and that the exporter has an executable Chromium with local
Latin, CJK and Arabic font coverage. These checks do not replace editing and
exporting an actual design after a disconnected installation. Factory
configuration is generated by `factory_penpot.py`; complete
team-directory enforcement and offline installation acceptance remain separate
integration work. Nginx resolves the configured private backend/exporter names
at request time, so a delayed dependency does not prevent the static editor
starting or leave a replaced service address cached indefinitely. The exporter
joins both the private control and data networks to reach its dedicated cache.

### Distributing corresponding source

Create the corresponding-source archive from the checksum-verified Penpot
archive and the exact original OpenCode tree, not from a running container:

```sh
python3 install/package_penpot_sources.py \
  --cache /path/to/penpot-download-cache \
  --opencode-source /path/to/verified-original-opencode \
  --output /path/to/release/teamaibox-design-source.tar.gz
```

The archive contains the full modified Penpot and OpenCode source, their original
licenses and notices, the exact integration overlays, input locks, build recipes
and this guide. `SOURCE-MANIFEST.json` lists the upstream identities, every
modified Penpot file and payload hashes. Its Penpot source key and tree digest
must match the build's recorded source before distributing the two together.
The archive has normalized file timestamps and ownership, and refuses to
overwrite an existing output. It does not read service volumes, browser state,
credentials, model stores or build logs. It does not publish anything.

Before pairing the archive with runtime images, use `verify_archive` from the
packaging module to verify its declared file set, file hashes, modes, safe links
and required notices. This integrity check is not a digital signature: the
distributor must also compare its source key and native tree digest with the
approved image build record.

Keep this source archive accessible alongside any binary distribution of the
modified components. Preserve the MPL notices on covered source and MIT notices
on OpenCode; retain dependency-specific licenses as well. The product Git
repository distributes the reviewed overlays and recipes, not this generated
archive or upstream binaries. The source release allowlist explicitly names
these files; generated artifacts and private website files remain excluded.
This source archive is not the complete offline installation package or a
replacement for its runtime dependency and license inventory.

Penpot's top-level source license is MPL-2.0; preserve file notices and component-specific licenses (including MCP package notices) rather than relabeling upstream code MIT. Distribute corresponding modified source/patches and build instructions alongside future release materials.

The `plugins/LICENSE` is also MPL-2.0; the vendored `frontend/packages/mousetrap/LICENSE` is Apache-2.0. The MCP root declares MPL-2.0 while its server package.json declares MIT; preserve both notices and source headers rather than treating the package metadata as permission to remove the enclosing notices. Lockfiles and actual build inputs must feed the final third-party inventory; this source map is not a completed runtime SBOM.

[GHSA-ch2q-6x56-qg5r](https://github.com/penpot/penpot/security/advisories/GHSA-ch2q-6x56-qg5r) covers an old MCP WebSocket bind-address flaw (fixed upstream in 2.18.0). Using a newer source does not substitute for verifying actual exposed ports, authenticated routing and current security advisories before release. Native multi-user token routing is not an OpenCode-session or document-authorization boundary.

The [upstream advisory inventory](https://github.com/penpot/penpot/security/advisories) was checked on 2026-11-05 (24 published records). It covers MCP listener/REPL exposure, media/font/token XSS, SSRF, export command injection, shared-file scope, team roles, session logout, uploads and invitation/account takeover. Version 2.18.5 is newer than the published fixes. Two records contain inconsistent range/fix metadata (`GHSA-4f36-m4hj-cv86`, `GHSA-4937-35vc-hqjj`); `GHSA-22qr-rp27-j9wm` lists an unbounded affected range despite naming a fixed version. Do not turn this inventory into a claim of zero vulnerabilities. Preserve exporter `execFile` argument separation, native sanitizers and permission checks; verify these affected boundaries after adapting authentication and routes. The pilot separately confirmed both MCP listeners are loopback-only and REPL is absent.

The standard Team AI Box installation registers Design in the product catalog.
Do not treat a working editor, successful model write or successful export as
offline installation or native database upgrade approval. Those are separate
checks against the exact release package and compatible target.
