# Text Recognition ApplicationPlugin

The application container serves static UI only. Browser uploads are hashed and
sent to the platform Object API, which commits them through the encrypted object
service and returns a short-lived compute reference. OCR jobs receive only that
reference identifier. Results expose editable text, page/layout blocks,
confidence, export, provenance, and object-reference handoff to Translation.

`manifest.release-template.json` is intentionally not installable. The ARM64
release pipeline must replace its OCI placeholders, attach SBOM/provenance, and
sign the canonical manifest with the protected official key.

The logical route `local/ocr-default` remains unavailable until an OCR profile
has completed deployment and certification on supported hardware.
