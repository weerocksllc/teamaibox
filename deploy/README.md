# Deployment

Deployment definitions are split by intent:

- development: local dependency and service manifests
- appliance: digest-pinned ARM64 appliance manifests and service health policies

Compose definitions live in compose/core.yaml with development and appliance
overlays. The committed ARM64 image lock records both upstream index and
selected-platform digests. Actual business services use their own release
images; a health-only foundation image is not evidence that an application is
implemented or ready. The current single-appliance deployment and remaining
acceptance items are recorded in
`docs/validation/single-appliance-consolidation-20261016.md`.

`compose/resource-policy.json` classifies core services and maps their health
objectives. It declares no shared reservation pool or startup floor. Container
safety limits, authenticated health and exact installation identities remain.

No manifest in this directory may silently mutate host drivers, networking,
storage layout, Secure Boot, or firmware.
