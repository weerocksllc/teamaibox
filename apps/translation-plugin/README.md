# Translation ApplicationPlugin

This independent application submits text directly or protected object
references through one queued Translation API. The request declares a
deterministic workflow: image/document inputs compose OCR and translation;
audio inputs compose ASR, translation, and subtitle assembly. Video translation
is explicitly not deployed in the current worker profile. A verified
OCR/ASR handoff can skip the already-completed extraction stage without losing
its intermediate provenance.

The UI exposes real durable-job progress, aligned segments, editable output,
subtitle/text export, workflow stages, and protected OCR/ASR intermediate
downloads for review. It does not claim availability until every required model
profile is deployed and certified.

`manifest.release-template.json` is intentionally not installable. The ARM64
release pipeline must replace OCI placeholders, attach SBOM/provenance, and sign
the canonical manifest with the protected official key.
