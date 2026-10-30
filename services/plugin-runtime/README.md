# Plugin Runtime

Validates plugin packages and permissions, stages lifecycle changes, tracks
compatibility/health, delegates user access to ApplicationPlugins, and
registers ComputePlugin capability declarations for scheduler use.

It requests Node Agent operations through contracts and never receives direct
Docker or device access.

## Signed manifest boundary

`src/manifest-validator.mjs` is the fail-closed structural boundary before any
container or migration may be staged. It accepts exactly one plugin type,
requires digest-pinned `linux/arm64/v8` OCI variants, checks type-specific entry
points and API access, validates locale/fallback/direction and Light/Dark
declarations, and reconciles permissions, unified-memory resources, probes,
migrations, dependencies, and compatibility ranges.

The signature declaration is Ed25519 over
`teamaibox.canonical-json/v1`: recursively sorted JSON for the complete
manifest with the top-level `signature` member omitted. The validator recomputes
and compares `signature.payloadDigest`. Trust-store lookup, actual signature
verification, provenance, SBOM, and vulnerability gates belong to the bundle
import pipeline and happen before lifecycle staging.

## Verified import pipeline

`PluginImportService` routes marketplace, private-registry, and offline-bundle
requests through the same gates. Offline selection additionally requires the
expected signed bundle-index SHA-256. Source adapters expose byte streams; the
runtime hashes them incrementally, retains only bounded JSON evidence, and does
not buffer OCI layers into control-plane memory.

Import order is fail closed: strict manifest → publisher-scoped Ed25519 trust →
signed bundle index → platform/API/capability/dependency/permission policy →
every artifact size/SHA-256 → exact ARM64 image coverage → SPDX SBOM → SLSA v1
provenance → fresh passing vulnerability report. Only then may the verified
record be written. The result omits source locators and the full signed manifest;
the durable repository retains the manifest, signer IDs, digest inventory, and
evidence references for staging and audit.

`PostgresPluginImportRepository` stores the record transactionally in
`plugins.verified_imports`. `(plugin_key, version)` is immutable: exact retries
are idempotent, while changed manifest or bundle digests are rejected.

## Plugin access channels

`DelegatedUserTokenService` issues ApplicationPlugins opaque, short-lived user
delegations only after rechecking the active local-user session, the enabled
plugin version/generation, manifest-declared API scopes, exact resource binding,
and the user's live authorization. Tokens live for 15–300 seconds, are returned
only at issue time, and are persisted only as peppered HMAC-SHA256 digests.
Every API authentication rechecks the session, plugin generation, scope,
resource, and current user authority. User, session, or plugin revocation is
immediate; upgrades and disable/uninstall also fail closed through the durable
plugin generation/state binding.

`ComputeCapabilityRegistrationService` accepts no user token and no direct
plugin authority. A scheduler authority verifier derives the worker, node,
lease, fencing token, and generation from the protected control channel. A
worker can register only its assigned certified model profile and a subset of
that profile's logical operations. Registration contains no endpoint, user,
physical GPU, or routing choice. PostgreSQL repeats all active-plugin,
worker-health/fence, certification, and operation checks in the atomic insert,
and scheduler reads filter stale or expired registrations again.

Migration 18 stores hash-only delegated-token grants and fenced compute
capability registrations. Both memory and PostgreSQL repositories implement
the same service boundary.

## Public SDK examples and compatibility

`PluginCompatibilitySuiteV1` applies the same signed-manifest, publisher,
sandbox, health, and documented-API checks to official and third-party
plugins. It has no official-plugin exception path.

The audited examples under `examples/plugins` exercise only public SDK
surfaces: Team Notes uses a fresh request-bound delegated user token, while the
text-transform worker uses fenced worker-control v1 and leaves capability
registration to the scheduler. Their Dockerfiles are dependency-free and run
as UID/GID 10001. See `docs/architecture/sample-third-party-plugins.md` for the
release-fixture boundary and Spark verification details.

`test/assurance-scenario-coverage.v1.json` is the required lifecycle and
supply-chain negative-test inventory. Its coverage test prevents offline
install, architecture, permission, signature, migration, rollback,
persistent-data, or supply-chain scenarios from disappearing unnoticed.
