# Plugin SDK

Public ApplicationPlugin and ComputePlugin contracts, delegated API client,
manifest types, and locale/theme host bridge. The SDK cannot expose private
platform modules, Docker, devices, host mounts, or permanent credentials.

`src/manifest-v1.d.ts` is the public discriminated TypeScript contract for the
signed v1 manifest. Application plugins expose only a browser entry point and
delegated-user APIs; compute plugins expose only the scheduler worker-control
entry point. Both declare digest-pinned ARM64 OCI variants, UI/catalog
metadata, locale and direction readiness, semantic Light/Dark compatibility,
permissions, a unified-memory resource envelope, health probes, migrations,
and compatibility ranges.

`src/access-v1.d.ts` defines exact ApplicationPlugin delegation grants and the
short-lived in-memory launch credential contract. Delegations are audience,
session, plugin-version/generation, scope, and resource bound; plugins must not
persist or place them in URLs. ComputePlugin capability claims contain only a
certified model-profile ID and logical operations. They travel inside the
fenced worker-control channel, and the public SDK deliberately exposes no
direct registry mutation method, endpoint selection, user token, or physical
device identity.

The dependency-free runtime helpers follow the same boundary:

- `delegated-client.mjs` obtains a fresh short-lived token per request and sends
  it only in the Authorization header to `/api/plugin/v1/invoke`; the body
  carries one exact scope, resource, logical operation, and optional
  idempotency key;
- `worker-control-v1.mjs` validates fenced scheduler requests and constructs a
  response that must match request, worker, correlation, lease, fence, and
  `replyTo`. It exposes no Docker, scheduler registry, or route selection API.
- `preferences-v1.mjs` resolves active locale, fallback and text direction,
  selects Light/Dark compatibility, validates the complete semantic-token set,
  emits revisioned live snapshots, applies language/direction/theme and semantic
  CSS variables inside the plugin document, and provides exact-origin iframe messaging.
  The compatibility result contains launch-time disclosures for every fallback;
  official plugins fail closed if any platform preference is unsupported.
