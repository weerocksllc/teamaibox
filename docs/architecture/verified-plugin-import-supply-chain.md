# Verified plugin import and supply-chain gates

OpenSpec task: `6.2`

## Sources share one security boundary

Marketplace, private OCI registry, and signed offline bundle imports are source
adapters, not separate trust models. Each adapter returns the same v1 package
descriptor plus byte streams. The offline path also requires the administrator-
selected bundle's expected signed-index SHA-256 before any persistent write.

The signed bundle index binds the canonical manifest payload digest and the
name, kind, media type, size, SHA-256, architecture, image identity, and subjects
of every artifact. Both manifest and bundle signatures are Ed25519 and must
resolve to an active, time-valid, publisher-scoped key authorized for the plugin
ID.

## Fail-closed gate order

1. Validate the strict signed plugin manifest.
2. Verify publisher trust and the manifest signature.
3. Recompute and verify the signed bundle index (and offline expected digest).
4. Enforce platform, Plugin API, runtime capability, installed dependency, API
   scope, object namespace, network, and administrator policy.
5. Stream every artifact through exact byte-count and SHA-256 verification.
6. Match every manifest image to exactly one pinned `linux/arm64/v8` OCI image
   manifest.
7. Require an SPDX JSON SBOM covering every image digest.
8. Require an in-toto SLSA provenance v1 statement whose subjects cover every
   image digest and whose builder identity is present.
9. Require a passing, fresh vulnerability report built from a fresh database;
   apply configured critical/high severity limits.
10. Persist the verified import atomically.

No repository write occurs before the last gate. Source readers are closed on
success or failure. Artifact hashing is incremental; only bounded supply-chain
JSON is captured, so an OCI layer cannot consume control-plane memory merely by
being imported.

## Durable evidence

Migration 16 creates `plugins.verified_imports`. It retains the full signed
manifest, manifest and bundle signer IDs/digests, image digests, bounded artifact
descriptors, SPDX/SLSA/vulnerability evidence digests and status, policy version,
source kind, and verification time. It deliberately does not retain marketplace
URLs, private registry credentials, uploaded archive paths, public keys, or raw
OCI content.

`(plugin_key, version)` is immutable. An exact verified retry is idempotent;
changed manifest or bundle content for the same semantic version is rejected.
The import result presented to callers omits the full manifest and source
locator. Lifecycle staging consumes the internal durable record in the next
phase.
