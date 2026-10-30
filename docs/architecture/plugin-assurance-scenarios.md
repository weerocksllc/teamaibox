# Plugin lifecycle and supply-chain assurance

OpenSpec task 6.7 is enforced by an executable scenario inventory at
`services/plugin-runtime/test/assurance-scenario-coverage.v1.json`. A contract
test proves that every required scenario points to an exact test name, so a
rename or accidental removal fails CI instead of silently reducing coverage.

The scenarios cover:

- a signed offline bundle moving through checksum, signature, compatibility,
  dependency, permission, ARM64, SBOM, provenance, and vulnerability gates
  before an atomic lifecycle install;
- x86/ARM64 descriptor mismatch and selected offline-file digest mismatch;
- an excessive API-scope count and unapproved scopes failing before verified
  persistence;
- invalid manifest and bundle Ed25519 signatures failing with no import record;
- migration failure before runtime start or cutover;
- failed upgrade health rolling back migrations and retaining the prior active
  version/slot;
- uninstall retaining the stable plugin data namespace and migration evidence,
  while refusing an implicit purge; and
- missing, corrupt, stale, incomplete, or policy-failing supply-chain evidence.

The positive offline-install scenario also asserts that signer identities,
image/artifact digests, SPDX digest, SLSA provenance digest, vulnerability
report digest/status, and verification state remain available to lifecycle
staging. Import results omit source locators and secret material.

These tests run in the ordinary Node contract suite and therefore execute in
the same locked ARM64 container on the designated Spark as other plugin and
scheduler contracts.
