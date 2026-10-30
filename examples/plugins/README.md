# Third-party plugin examples

These two dependency-free examples are intentionally small enough to audit:

- `team-notes` is an `ApplicationPlugin`. Its business operation obtains one
  request-scoped delegated user token and calls the documented Plugin API.
- `text-transform-worker` is a `ComputePlugin`. It implements only
  `teamaibox.worker-control/v1`; capability registration remains a scheduler
  operation.

Both use the public `@teamaibox/plugin-sdk`, run as UID/GID 10001, and pass
`teamaibox.plugin-compatibility/v1`, the same policy class used for official
plugins. The committed manifests and public key are deterministic signed
conformance fixtures. Their `registry.example.test` references and repeated
image digests are not distributable OCI releases. A release pipeline must
replace each image reference/digest with the built OCI artifact, regenerate
supply-chain evidence, and sign the resulting manifest with the publisher's
protected release key.

`tools/sample_plugin_smoke.py` stages only these examples and the public SDK on
the configured DGX Spark. It builds with the locked ARM64 Node image and no
build network, exercises the HTTP/worker boundaries in isolated containers,
then removes and verifies all run-specific state.
