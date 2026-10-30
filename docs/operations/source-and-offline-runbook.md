# Source and offline operations runbook

## Source policy

Pip, npm, and APT are managed together in Source Center. Each ecosystem may use
the appliance cache/mirror, an administrator-approved external source, or an
approved offline repository. Agent/plugin/worker containers reach sources only
through the containerized source/egress gateway; they do not inherit host proxy
configuration and never install packages on the host.

For each source record ecosystem, URL or offline-media identity, trust roots,
allowed package/name/version patterns, priority, fallback, cache policy,
credential reference, health, and revision. Credentials are write-only and
must not appear in diagnostics. A policy selects ordered sources by sandbox
class and data/egress rules. Changes require source administration and audit.

## Online operation

Use `GET /api/v1/admin/source-center/overview` to review all ecosystems and
health. Create or update sources and policies through the `/sources` and
`/policies` collections, then run the source health action. Test one clean
sandbox per ecosystem before enabling the policy. A successful TCP connection
alone is insufficient: verify signed metadata, trust chain, exact package,
cache digest, and expected no-direct-egress behavior.

When the Internet source is unavailable, the gateway follows the configured
policy; it does not silently change trust roots or fall back to an undeclared
public mirror. Existing verified cache entries may be served only within their
freshness and policy limits.

## Offline media import

Attach the administrator-supplied disk read-only where practical and discover
it through `POST /api/v1/admin/source-center/offline-media/discover` with the
configured local appliance ID. The Node Agent reports a stable media identity and signed
bundle indexes; the browser never accepts an arbitrary host path.

Inspect the discovered item, expected index digest, publisher/trust metadata,
ecosystems, architecture, package counts, expiry, and collision results. Only
then approve the exact media ID and digest. Enumerate artifacts through its
`/artifacts` route and sample integrity before enabling a policy. Pip wheels,
npm packages, and APT packages/repository metadata must match target ARM64 or
declared architecture and their own signature/hash rules.

The offline Web servers run in the source-gateway container and expose only the
configured sandbox network, never an unauthenticated LAN-wide mirror. Removing
the disk makes that source unhealthy; active installs fail clearly or use the
next explicitly configured source.

## Update, rollback, and incident handling

Stage a new repository/index generation alongside the current generation,
validate it, then atomically update policy revision. Keep the previous verified
generation until clean-sandbox tests pass. On signature, digest, dependency,
architecture, trust, or content mismatch: disable the source, stop new fetches,
preserve bounded metadata evidence, invalidate affected cache entries, identify
tasks by digest, and rotate exposed credentials. Never “fix” an offline index
in place.

APT for DGX OS, driver, firmware, Docker, or NVIDIA runtime maintenance is not
this gateway. Those packages use the dedicated Host Maintenance workflow and
host allowlist.

