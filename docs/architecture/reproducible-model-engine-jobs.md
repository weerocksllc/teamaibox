# Reproducible model engine build and deployment jobs

Model engine generation and deployment are durable, administrator-created,
node-exclusive jobs. A job is identified by the SHA-256 of one canonical
specification; display names, mutable tags, ambient environment variables, or
the current contents of a registry never define its identity.

## Build specification

The v1 build specification pins:

- candidate, publisher model name, immutable source revision, and a verified
  protected source-artifact digest;
- the builder OCI reference including `@sha256`, plus the build entrypoint
  digest;
- Linux ARM64, OS identity, exact CUDA, engine, framework, and version facts;
- passthrough/export/quantize/quantize-export kind, quantization scheme, tool
  and version, canonical parameters plus their digest, optional calibration
  dataset digest, and a digest over the complete recipe;
- the exact named output contract and media types;
- `networkMode=none`, `SOURCE_DATE_EPOCH`, `C.UTF-8`, and `UTC`; and
- node-exclusive CPU, unified-memory, and storage requirements.

Quantization requires both a scheme and a calibration dataset digest.
Non-quantized builds must declare neither. Parameters are bounded canonical
JSON and reject credential-like keys. The source artifact must be `ready` in
the encrypted model cache and match the declared candidate and revision; the
calibration artifact must also be ready before queue insertion.

## Build result attestation

A claimed worker can complete a build only with the current unexpired claim
fence. The result repeats the specification fingerprint, builder image,
runtime, recipe/parameter/calibration digests, and provides exact output
digests and sizes, provenance, SBOM, bounded-log, and observed-environment
digests plus a canonical time interval. Any drift fails before promotion.

Every output must already exist with the declared size in 7.3's protected
model artifact cache. A successful record is immutable. The output list becomes
the only source accepted by a later deployment job.

## Deployment specification and result

Deployment is allowed only from a successful build. Its canonical specification
pins the build ID and fingerprint, exact build output descriptors, digest-pinned
serving image, exact runtime, bounded non-secret configuration and its digest,
ARM64 accelerator/resource class, shared or exclusive execution mode, and the
health path/startup/threshold contract.

The completion attestation must prove the same serving image, runtime,
configuration digest, and exact output-digest set. It adds deployment-manifest,
environment, and health-evidence digests. Both successful and failed outcomes
are worker-fenced; claim tokens are stored only as SHA-256 values in PostgreSQL.

## Persistence and replay

Migration 21 stores build/deployment jobs and separate idempotency-operation
aliases. Build key, deployment key, specification, fingerprint, source build,
requester, and creation facts are immutable. Legal transitions are only:

```text
queued -> running -> succeeded | failed
```

Terminal rows cannot change. PostgreSQL independently rejects a deployment
unless its source build succeeded and its embedded build fingerprint and output
array exactly equal the build result. Advisory locks serialize operation-key
creation. A second operation for the same fingerprint becomes an alias to the
same durable job; later reuse of that operation with changed facts conflicts.

The jobs describe reproducible work but do not claim bit-for-bit reproducibility
for a tool until the output digests are repeated in validation. Variation is
evidence for later build/quality stages, never silently overwritten.
