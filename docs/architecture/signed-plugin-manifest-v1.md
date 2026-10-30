# Signed plugin manifest v1

OpenSpec task: `6.1`

## One contract, two plugin types

Every official or third-party plugin uses
`teamaibox.io/plugin/v1`. `ApplicationPlugin` and `ComputePlugin` are a closed,
discriminated pair rather than informal labels:

- an ApplicationPlugin has one Web entry point, delegated-user API access, no
  direct device scope, and a user launch route;
- a ComputePlugin has one `teamaibox.worker-control/v1` entry point,
  scheduler-only capability registration and API access, and no browser launch
  route.

Both types declare digest-pinned OCI image variants for `linux/arm64/v8`,
catalog UI metadata, supported/fallback locales, LTR/RTL readiness, Light/Dark
compatibility, semantic-token and live-preference behavior, explicit API and
runtime permissions, a complete CPU/unified-memory/storage/network envelope,
startup/readiness/liveness probes, data migrations, and platform/plugin API/
runtime/dependency compatibility ranges. The resource contract deliberately
contains unified memory and no synthetic dedicated-VRAM field.

Official plugins additionally must cover the initial platform locales
`zh-CN`/`en`, both Light and Dark, and live preference events. Third-party
plugins may declare a smaller compatibility surface so the marketplace and app
launcher can disclose the fallback before use.

## Signature payload

The required signature declaration is:

- format: `teamaibox.canonical-json/v1`;
- algorithm: `Ed25519`;
- publisher-scoped key ID;
- SHA-256 digest of the canonical unsigned payload;
- one canonical base64-encoded 64-byte signature.

The unsigned payload is the complete manifest with its top-level `signature`
member omitted, encoded as JSON with recursively sorted object keys and arrays
kept in declared order. The runtime recomputes the payload digest. Trust-store
resolution and cryptographic verification are deliberately performed by the
subsequent import/supply-chain gate, not by schema parsing alone.

## Validation boundary

`services/plugin-runtime/src/manifest-validator.mjs` is called before any
container or migration is staged. It rejects unknown members, type confusion,
missing ARM64 variants, mutable image references without a digest, duplicate
identities, invalid fallback/direction/theme declarations, incoherent network
policy, invalid CPU limits, unowned migration images, self-dependencies, and a
canonical payload digest mismatch. It returns only bounded identity, type,
version, architecture, and digest facts for later lifecycle stages.

The JSON Schema is cataloged as the stable public plugin request contract, and
the Plugin SDK publishes matching discriminated TypeScript definitions.
