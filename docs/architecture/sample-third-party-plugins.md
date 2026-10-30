# Sample third-party plugins

The reference examples prove that a community plugin does not need private
platform imports or direct appliance access.

## ApplicationPlugin path

`example.team-notes` serves a browser entry point and health endpoints. Its
host integration imports `createDelegatedPluginClient` from the public SDK.
Every operation asks the host for a fresh short-lived token, places it only in
the Authorization header, and sends an exact declared scope, resource,
operation, and bounded body to `/api/plugin/v1/invoke`. It never stores a user
token and requests no device or network access.

## ComputePlugin path

`example.text-transform` imports the public worker-control helper. It accepts
fenced `prepare`, `execute`, `cancel`, and `unload` messages, returns correlated
responses, and reports only its assigned logical model profile and operation.
It has no user-token path and exposes no capability-registry endpoint. The
scheduler remains the only authority that can turn a healthy, leased worker
claim into a routable capability.

## Uniform certification

`PluginCompatibilitySuiteV1` validates the signed manifest, publisher trust,
shared sandbox baseline, runtime health, documented v1 API surface, and the
type-specific access boundary. Its result always identifies policy class
`uniform-official-and-third-party`; there is no official-plugin bypass.

The committed manifests are signed deterministic test fixtures, not release
packages. Production publishing must bind the manifest to the actual ARM64 OCI
digest and pass the verified import pipeline's SBOM, SLSA provenance,
vulnerability, artifact hash, and signature gates.

## Hardware verification

The Spark smoke builds both source trees from the locked digest-pinned ARM64
Node base with build networking disabled. Runtime containers are non-root,
read-only, capability-free, network-isolated, device-free, and mount-free. It
checks ApplicationPlugin readiness, a complete ComputePlugin prepare/execute
exchange, scheduler-only logical claims, absence of a direct registration
endpoint, ARM64 image identity, cleanup, and residual state.
