# Plugin API v1

## Plugin types and boundary

Team AI Box supports exactly two plugin types. An `ApplicationPlugin` supplies
a browser application and accesses platform APIs only through a short-lived
delegated user grant. A `ComputePlugin` supplies scheduler-controlled worker
capabilities and has no user session, UI authority, direct scheduler mutation,
or right to choose a node/provider. One manifest cannot declare both types.

The public contract is `packages/plugin-sdk`; the signed manifest schema is
`packages/contracts/plugins/manifest.v1.schema.json`. Plugins must not import
private repository modules, mount the Docker socket, use host PID/network
namespaces, access raw devices, or persist platform credentials.

## Signed manifest and package

Manifest v1 declares a stable plugin ID and version, one type-specific entry
point, a digest-pinned `linux/arm64/v8` OCI image, locales/fallback/text
direction, semantic Light/Dark theme compatibility, exact permissions,
resources, health probes, migrations, dependencies, and platform/API ranges.
Its Ed25519 signature covers canonical JSON with the signature member omitted.

Marketplace, private-registry, and offline bundles use the same fail-closed
pipeline: schema, publisher trust, signed bundle index, compatibility,
permissions, artifact digest/size, ARM64 coverage, SPDX SBOM, SLSA provenance,
and a fresh passing vulnerability report. `(plugin_id, version)` is immutable;
an exact retry is idempotent and changed bytes are rejected.

## ApplicationPlugin access

The host launches the UI with locale, direction, semantic theme tokens, plugin
generation, and an opaque launch context. For each protected request the SDK
obtains a fresh 15–300 second delegation and sends it only as:

```http
Authorization: Bearer <opaque-delegation>
POST /api/plugin/v1/invoke
Content-Type: application/json
```

The body contains exactly one declared scope, bound resource, logical
operation, and optional idempotency key. The grant is user, session, plugin
version/generation, audience, scope, and resource bound. Never put it in a URL,
log, local storage, database, service worker cache, analytics event, or child
process. The platform rechecks the user's current authority on every call;
sign-out, account disable, permission change, plugin upgrade/disable/uninstall,
or generation change revokes it.

Use `DelegatedPluginClientV1` and the preference bridge from
`packages/plugin-sdk`. UI assets run in the plugin container and must preserve
keyboard focus, reduced motion, long localized text, responsive layout, error,
empty, loading, disabled, warning, and confirmation states.

## ComputePlugin worker control

A ComputePlugin receives only a mutually authenticated, scheduler-issued
worker-control v1 request containing the logical operation, protected artifact
references, correlation/job/attempt identifiers, lease, fencing token,
generation, deadline, and reply subject. Validate all fields with the public
worker-control helper before work. A response must echo the exact request,
worker, lease, fence, generation, correlation, and reply binding.

Capability registration is performed through the protected scheduler authority
after worker/node health and model certification checks. A worker declares only
its assigned immutable model-profile ID and a subset of that profile's logical
operations. It never publishes an endpoint, GPU identity, route decision, user
token, or storage credential. Batch requests must cross the durable queue;
realtime workers use the separate reservation/session contract.

## Lifecycle, persistence, and compatibility

Install and upgrade stage the new container, run bounded migrations, health
check, then atomically switch generation. Failure leaves or restores the prior
healthy generation. Disable stops new launches/capability routing; uninstall
removes runtime state only according to declared retention policy. Plugin data
lives in a Node Agent allocated encrypted bind path, never an anonymous Docker
volume.

Run the public compatibility suite and sample plugins before publishing. There
is no official-plugin exception. Breaking changes require a new versioned API;
unknown fields and undeclared permissions fail closed.

## Compute API relationship

ApplicationPlugins and Agent sandboxes invoke logical AI operations through the
[Compute API v1](compute-api-v1.md). They cannot bypass the queue by calling a
model worker directly. The Compute API's OpenAI-compatible surface is the
client contract; worker-control v1 is an internal, fenced execution contract.
