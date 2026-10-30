# Source Gateway

Shared Source Center policy for approved online upstreams, external mirrors,
appliance cache, offline media, architecture/compatibility metadata, and audit.

The administrator control plane is implemented by `SourceCenterService`. It
normalizes PIP, NPM, and APT sources into one model while preserving native
protocol data planes. Every source declares a stable key, kind, internal/LAN/
Internet endpoint, deterministic priority, package scopes, supported
architectures, checksum and signature policy, protected credential reference,
online mode, cache limits, optional storage-pool binding, enabled state, and
health. Internet endpoints require HTTPS and URL-embedded credentials are
rejected. Credential values are never accepted or returned by this service.

Routing policies select an ordered set of same-ecosystem sources by workload
environment, team, sandbox profile, and architecture. They also carry the
online/offline requirement and package allow, deny, or version-pin rules.
Source and policy changes use optimistic revisions and emit redacted audit
events. Health observations have immutable history in PostgreSQL migration 34.

Offline disks enter through a separate read-only mounted-media adapter. A
trusted node inventory supplies stable device facts while the Source Gateway
itself hashes `manifest.json`, verifies its detached OpenPGP signature, hashes
and sizes every declared artifact, verifies any required artifact signature,
rejects AMD64-only content, indexes dependencies, and publishes health plus a
redacted inventory. Approval is revision- and manifest-digest-fenced. Media
handles and mount paths are never returned to the browser. Removal immediately
changes the medium to `detached`; reattachment always requires reapproval.
PostgreSQL migration 38 persists current inventory and append-only approval
evidence.

The administrator API is rooted at `/api/v1/admin/source-center`, and the Web
console supports both light and dark themes and Chinese/English locales. The
control plane can use the in-memory repository for isolated development or the
PostgreSQL repository for appliance persistence.

Protocol data planes remain separate:

- gateways/pip: Python Simple API proxy/cache/offline adapter
- gateways/npm: NPM registry proxy/cache/offline adapter
- gateways/apt: APT repository/proxy/offline adapter

`test/assurance-scenarios.v1.json` is the release coverage contract for online
proxying, cache hits, fully offline closure, missing dependencies, deterministic
priority in all three ecosystems, pin/deny, credential redaction, corrupted and
wrong-architecture artifacts, and offline-media removal. Its coverage test
fails when any named executable scenario disappears.

Agent sandboxes and build environments use internal endpoints. Host OS,
kernel, driver, and firmware maintenance uses a separate protected channel.

Sandbox startup generates immutable client files for the fixed internal data
planes: Pip uses `/pip/simple/`, NPM uses `/npm/registry/`, and APT uses the
signed ARM64 `teamaibox` suite under `/apt`. The Node Agent independently
validates the exact file contents before projecting them into a root-owned,
read-only tmpfs. Alternate indexes, registry credentials, authorization
headers, URL credentials, upstream hostnames, and unsigned APT sources are not
part of the sandbox contract and are rejected before runtime projection.

Agent package access and general Internet access are separate controls. Pip,
NPM and sandbox APT receive only generated internal client configuration and
no upstream credential. The sandbox network is internal; optional general
Internet traffic can leave only through the `agent-egress-gateway` alias. Its
authorizer requires an exact administrator allowlist, resolves the approved
hostname itself, and rejects loopback, private, link-local, metadata and IP
literal destinations before a data-plane connection is opened.
