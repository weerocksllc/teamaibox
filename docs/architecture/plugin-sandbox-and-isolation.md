# Plugin sandbox and isolation

OpenSpec task: `6.4`

## Trust boundary

Application and compute plugins never receive the Docker socket and cannot
start containers directly. The plugin runtime compiles a signed manifest and
administrator-approved permission policy into a bounded sandbox request. The
Node Agent independently validates that request before its sole Docker API
boundary creates a container. A plugin request is denied closed when either
layer rejects it.

Every plugin container is non-root, read-only, capability-free, protected by
`no-new-privileges`, denied host PID/IPC/network namespaces, and bounded by
memory, CPU, PID, open-file, and ephemeral-tmpfs limits. The Docker socket,
privileged mode, bind mounts, undeclared host paths, and raw secret environment
values are not expressible in an accepted sandbox request.

## Filesystem and identity namespaces

Plugin data and cache are separate named volumes derived deterministically
from the full plugin ID digest. Only these two exact targets are accepted:

- `/var/lib/teamaibox/plugin/data`;
- `/var/cache/teamaibox/plugin`.

The volume names are plugin-specific, so one plugin cannot substitute another
plugin's retained data namespace. The root filesystem remains read-only and
`/tmp` is a bounded `noexec,nosuid,nodev` tmpfs. Runtime containers carry the
plugin ID and workload kind as ownership labels in addition to node, lease,
fencing, and image identity.

## Network, APIs, and devices

No network is the default. Declared egress is routed only through the managed
`plugin-egress-proxy` and is bound to a digest of plugin ID plus a sorted exact
hostname allowlist. Wildcards, loopback, host aliases, link-local destinations,
and the cloud metadata address are rejected. Direct host or bridge networking
is not permitted.

Delegated API scopes must be sorted, unique, explicitly declared, and cannot
contain wildcards or administrator scopes. Application plugins receive no
device. Compute plugins can request only manifest-declared accelerator and
video-codec capabilities mapped to the Node Agent's NVIDIA device classes;
there is no generic device or direct-audio pass-through.

## Denials and audit

Sandbox violations are rejected before the runtime call with stable
`plugin_sandbox_*` error codes. Failure events record only the stable code and
bounded workload identity; rejected paths, raw environment values, tokens, and
other request material are not copied into the audit payload. An audit-sink
failure never converts a denial into an allow.

The real Spark boundary smoke starts and inspects an ARM64 plugin container,
then submits an undeclared `/etc` bind mount and proves it is denied before a
container exists. It also verifies the denial event is redacted and removes all
temporary containers, volumes, images, and files.
