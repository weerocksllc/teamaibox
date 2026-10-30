# Node Agent

Small Go service forming the privileged boundary on the single local appliance.
It authenticates fenced node commands, enforces pinned images and resource
limits, controls Docker/device access, reports owned worker lifecycle and safe
telemetry, and reconciles local state.

No plugin or platform business module receives the Docker socket. Node Agent
does not make scheduling or user-authorization decisions.

## Implemented control boundary

The Go service exposes only health and `POST /v1/commands` over TLS 1.3. The
command endpoint requires a verified client certificate plus a scheduler HMAC
proof (`key id`, nonce, signature), bounded issue/deadline times, command ID,
lease ID, and fencing token. Nonces cannot be reused for different commands;
the same signed command is idempotent and a changed payload under the same ID
is rejected.

Supported v1 commands are `worker.start`, `worker.stop`, `worker.health`,
`worker.control`, `worker.application.fetch`, the fixed-policy exclusive
conflict commands, `sandbox.file.project`, the read-only
`maintenance.preflight`, and the bounded
`maintenance.transaction.execute` command described below.
The same fenced lifecycle is used for compute workers, application plugins,
and compute plugins; `workloadKind` selects the stricter workload policy. The
start policy requires:

- exact OCI `@sha256` image reference already present on the node;
- non-root UID/GID, read-only root, all capabilities dropped, no new
  privileges, no host PID/network, no privileged mode, and no Docker socket;
- explicit CPU, memory, PID, open-file, and bounded `/tmp` tmpfs limits;
- assigned named volumes only, approved network, environment names, and
  NVIDIA device classes.

Node-exclusive jobs use a separate fixed drain policy. Every conflict target is
bound to an exact container name plus either immutable labels, an exact local
`sha256:` image ID, or both. The Node Agent re-verifies that identity before
each stop and restore, so an administrator can register a legacy model service
that has no Compose labels without granting arbitrary container control.

### Protected resident workers

A target in `TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE` may set
`placementClass` to `protected-resident`. Such a target must bind a unique
Worker UUID and model-profile UUID, the exact container name, actual local
image ID, pinned repository digest, configuration digest, immutable labels,
unique dependency-first `stageOrder`, explicit `dependsOnWorkerIds`,
and the same three immutable identities for every declared companion. Ordinary
`worker.start` cannot start a protected resident. Only the complete protected-set
transaction can create or recover these Workers; ordinary commands and other
placement classes cannot claim their Worker IDs.

Protected residents are omitted from ordinary exclusive-conflict inventory.
`worker.stop`, `worker.unload.request`, unknown future worker-control lifecycle
messages, ordinary drain/restore, and stale-node-generation eviction all fail
before a Docker mutation. Safe prepare, object-transfer, execute, cancel, and
health operations remain available. Existing optional/exclusive workers that
do not carry the protected placement label retain their prior behavior.

The only stop/restore path is a signed `maintenance.transaction.execute`
envelope over the existing TLS 1.3 client-certificate and scheduler-HMAC
boundary. Its payload must repeat the envelope's transaction/lease ID and
issue/expiry timestamps, use a window of at most fifteen minutes, authorize
only `protected-set.maintenance`, bind the exact complete protected Worker
list and exact ordered target/companion identities, and separately bind the
exact `operationOrder` of `protected.stop`, `protected.restore`, then
`protected.verify`. Maintenance and ordinary mutation commands are mutually
exclusive in-process. Set, signature binding, order, generation, revision,
identity, or prior health drift fails closed.

The first node-local journal revision is `1`; its positive
`maintenanceGeneration` must exactly match every protected target in the
static policy. Each later transaction advances the journal revision by one
and may retain that generation or advance it by exactly one after an atomic
policy/config successor. Generation regression or skipping fails closed.

Before the first stop, Node Agent atomically journals the signed command and
closed-plan digests in the owner-only state volume under
`TEAMAIBOX_NODE_STATE_DIR`. Each stopping/restoring/verifying phase and next
ordered target is persisted through file and directory `fsync`. On restart,
an incomplete transaction blocks every ordinary lifecycle mutation and
restores the exact target set in reverse target order; each Worker starts
before its companions, whose declared order is also reversed. Recovery is
allowed after the authorization window expires because it cannot authorize a
new stop, but configuration/node-generation drift or an invalid journal keeps
the Agent failed closed until the exact prior state can be recovered.

Plugin workloads additionally require a signed-manifest-derived plugin ID,
exact sorted API scopes, deterministic plugin-owned data/cache volumes, and
either no network or a digest-bound egress-proxy destination list.
Application plugins receive no device; compute plugins receive only declared
NVIDIA accelerator/codec classes. Host paths, host namespaces, wildcard or
metadata egress, root, privileged mode, and the Docker socket are rejected
before any Docker call and emit only a stable, redacted denial code.

The production runtime talks directly to the versioned Docker Engine Unix API
with Go's standard library. It does not invoke a shell and does not need a
Docker CLI inside the image. Every managed worker carries node, worker,
node-generation, attempt, lease, image, and fencing labels; health/stop refuse
containers whose ownership labels do not exactly match. Every command also
carries the configured appliance ID and current positive node generation; an old
generation is rejected before the Docker runtime is reached.

`maintenance.preflight` accepts no command line, package name, image pull,
filesystem path, or raw Docker request. It performs only Docker version/info
reads and a label-bounded managed-container inventory, then reports normalized
ARM64/Docker/CDI, Secure Boot, and active-workload facts with a closed digest.
Host or platform mutation remains a separate release-executor boundary and is
not implied by successful preflight.

Agent sandboxes add an owner-derived sandbox key, a label-verified persistent
workspace volume with an enforced quota declaration, builtin seccomp, no GPU,
and a non-persistent `/run/secrets` tmpfs. The file-projection command accepts
only an approved-provider OpenCode configuration or a bounded, short-lived
model token. It rechecks the running container's owner, sandbox, lease and
fence labels before using the Docker archive API; token contents are excluded
from results, events and error text and are zeroed from owned buffers after
use. Runtime tmpfs roots, OpenCode configuration, and package client files are
root-owned; the model token alone is readable by the non-root sandbox UID.
OpenCode can therefore reach models only through the internal OpenAI
gateway and a file-backed scoped credential.

The OpenCode configuration archive also pre-projects the exact root-owned,
read-only `.gitignore` sentinel that unmodified OpenCode creates beside its
configuration during first instance bootstrap. This keeps the runtime config
directory immutable to the sandbox UID without breaking real upstream startup;
making that directory user-writable is forbidden.

On every Agent sandbox start, Node Agent also validates and projects a
non-persistent Pip/NPM/APT client bundle into `/run/teamaibox`. Native client
environment variables point at those files and the internal Source Gateway;
external source URLs and upstream credentials are rejected. The sandbox
network itself is Docker-internal. General Internet proxy variables appear
only when the administrator policy enables at least one exact destination,
while compute and package gateways stay independently reachable.

Sandbox APT is not the appliance host's package manager. It installs only into
the sandbox's immutable-root container layer and sees only its owner workspace
named volume plus ephemeral runtime tmpfs. Host root binds, host namespaces,
the Docker socket, host APT configuration, and direct DGX/NVIDIA repositories
are rejected. OS, kernel, driver, firmware, boot, Docker, and NVIDIA Container
Toolkit maintenance uses the distinct `official-host-maintenance.v1` policy,
its own administrator permission, sources, recovery evidence, and future
privileged executor; Agent and plugin identities cannot enter that channel.

Commands emit ordered worker lifecycle/failure events through `EventSink`.
The executable currently serializes these redacted events to its service event
stream; the durable event-bus adapter consumes the same interface. Docker
readiness controls `/health/ready`, while `/health/live` remains available for
process supervision.

## Local appliance identity and telemetry

The Agent binds `127.0.0.1:9443` by default. `TEAMAIBOX_LISTEN_ADDRESS`
may select another loopback IP and port; wildcard and LAN listeners are rejected.
Run the platform client and Agent in the same host network namespace. Browsers,
plugins and workers never receive direct access to this command listener.

Installation supplies one exact UUID and positive execution generation using
`TEAMAIBOX_NODE_ID` / `TEAMAIBOX_NODE_GENERATION` or an existing local
`TEAMAIBOX_NODE_IDENTITY_FILE`. Existing persisted identity and generation files
remain usable so software updates do not recreate guests or rewrite their data.
Commands addressed to any other identity or a stale generation are rejected
before execution. No remote registration, SSH installation, node groups, model
rollout, cross-device file transfer or remote certificate activation exists.

TLS identity is loaded directly from `TEAMAIBOX_TLS_CERT_FILE` and
`TEAMAIBOX_TLS_KEY_FILE`; `TEAMAIBOX_CLIENT_CA_FILE` authenticates the local
platform client. Certificates are installation-managed files. Updating them
requires the normal controlled Agent restart; it does not enroll another node.

`TEAMAIBOX_APPLIANCE_ORIGIN` must be a literal loopback HTTPS origin.
`TEAMAIBOX_APPLIANCE_CA_FILE` and `TEAMAIBOX_APPLIANCE_SERVER_NAME` configure
its authenticated TLS connection. The Agent reports to:

- `POST /api/v1/appliance/heartbeat`: `{generation, inventory}`
- `POST /api/v1/appliance/metrics`: `{generation, snapshot}`

The Agent refuses redirects and verifies that accepted responses refer to its
exact appliance identity and generation. Inventory reloads before each 15-second
heartbeat. Local inventory failure is bounded to 40 seconds. A temporary local
platform restart retries without restarting surviving guests; explicit identity
or generation rejection still fences the command service. Metrics do not replace
heartbeats or invent unsupported GPU memory readings.

`appliance.inspect` is a signed, read-only command with `{inspectionId}` matching
both command ID and lease ID. It returns the local image/configuration identity,
host boot ID, TLS certificate fingerprint and Docker readiness. The deployment
sets `TEAMAIBOX_APPLIANCE_IMAGE_DIGEST` and
`TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST`. This command never installs files,
controls workloads or changes certificates.

When protected office targets are installed, the same read-only response includes
`protectedTargetPolicyDigest` and per-worker `runtimeIdentities`, selected only
from that policy. Each exact identity is checked against the local node, pinned
image, profile, configuration and start-spec labels. Read-only inspection accepts
the current generation or an older positive generation explicitly pinned by that
policy, so replacing the controller does not require restarting surviving models.
Future or unbound generations are rejected. Failed
identity reads are returned as unavailable, and stopped/unhealthy workers stay
stopped/unhealthy; appliance readiness is not model health. No acceptance bundle,
captured worker lease, new lease allocation or request-selected container is
needed. The ordinary Worker ownership and mutation checks remain unchanged.

## Retained local capabilities

Android and Windows guests retain independent persistent disks and their existing
ownership and runtime identities. Closing the page, replacing Web assets or
restarting the local control service does not reset a guest. Phone media, file
transfer and camera input use their scoped authenticated endpoints; USB cameras
are discovered only on this appliance. Windows desktop/console gateways remain
separate from the privileged command transport.

Protected-office maintenance, exact rollback, appliance runtime restart, camera
and guest-storage helpers remain local. The Docker API and privileged host
operations stay inside the Agent boundary; the platform exposes only the bounded
operations needed by the product.

## Validation

Run `go test ./...` and `go vet ./...` from this directory. Tests cover command
identity/fencing, removed-command rejection, loopback-only control/telemetry,
protected-worker recovery, guest persistence, cameras/storage, TLS transports and
read-only local inspection. Hardware acceptance remains separate: unit tests do
not prove live guest media, model quality or physical-camera behavior.
