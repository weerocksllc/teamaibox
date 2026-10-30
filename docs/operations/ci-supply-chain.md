# CI and release supply-chain gates

The foundation CI has three independent jobs:

- quality validates module/deployment manifests, migrations, event/API
  contracts, supply-chain locks, secrets, Node/Python tests, native Go tests,
  and an ARM64 Go cross-build;
- database-migrations runs both migrations, SQL smoke behavior, idempotent
  re-application, and reverse cleanup in a disposable ARM64 PostgreSQL
  container;
- arm64-image builds the foundation image twice with the same
  `SOURCE_DATE_EPOCH`, pinned BuildKit and base image, verifies an identical OCI
  manifest digest and non-root ARM64 config, and emits an SPDX JSON SBOM.

All third-party GitHub Actions are pinned to complete commit SHAs and must match
`deploy/supply-chain/actions.lock.json`. Updating an action requires reviewing
its exact release and changing both the workflow and lock in one change.

Release images are separate from pull-request builds. The manual
`verify-release-image` workflow accepts only a digest reference and one exact
GitHub workflow certificate identity. It verifies the keyless Cosign image
signature, SPDX JSON attestation, SLSA provenance v1 attestation, Fulcio issuer,
and transparency evidence. A tag alone can never pass this gate.
