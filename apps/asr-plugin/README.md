# Speech Transcription ApplicationPlugin

This read-only application container submits audio and video through the
platform Object API and queues transcription through the OpenAI-style compute
API. Jobs expose persisted queue/model/processing progress, cancellation,
timeline editing, language metadata, optional speaker information, export, and
model/source provenance. Browser one-shot uploads are deliberately limited to
64 MiB; larger inputs must already exist in the encrypted Team Drive until the
streaming multipart adapter is implemented.

`manifest.release-template.json` is intentionally not installable. The ARM64
release pipeline must replace all OCI placeholders, attach SBOM/provenance, and
sign the canonical manifest with the protected official key.

The logical route `local/asr-default` remains unavailable until an ASR profile
has completed deployment and certification on supported hardware.
