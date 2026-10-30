# Protected model artifact import and cache

Model artifacts use a dedicated metadata plane and the existing independently
deployed object-service byte plane. The platform never assembles a multi-GB
model in process memory. It transfers, verifies, encrypts, reads, and reclaims
one content-addressed chunk at a time.

## Import boundary

Only an administrator identity with `model:manage` may start, resume, promote,
pin, lease, or evict model artifacts. An import must identify a `planned`
candidate whose discovery decision is `allowed`; source revision, source URI,
artifact allow-pattern, and maximum byte count are inherited from the reviewed
candidate matrix. Blocked, gated, unreviewed, or oversized candidates fail
before a network request is opened.

Online import accepts an exact artifact name, byte size, SHA-256, media type,
chunk size, pinned HTTPS URI, and optional Ed25519 publisher signature. The
concrete HTTP adapter:

- requests an exact `Range` of at most 64 MiB;
- uses `If-Range` after the first ETag or Last-Modified response;
- rejects range/body/total-size mismatches and changing validators;
- omits credentials, referrers, and caches;
- follows only HTTPS redirects to the original or an explicitly approved CDN
  host; and
- bounds every request with a timeout.

One resume call can transfer a bounded number of chunks. The committed offset
and next ordinal live in PostgreSQL, so interruption never requires replaying
already verified bytes. Multi-chunk sources without a stable validator are
rejected. Final promotion re-reads the ordered chunks, hashes them incrementally,
checks the full artifact SHA-256, then verifies the optional publisher signature
over a canonical artifact descriptor. A `ready` artifact is never exposed
before all gates pass.

## Signed offline bundle

The offline source contract is `teamaibox.model-bundle/v1`. Its canonical,
Ed25519-signed manifest contains:

- candidate ID and exact reviewed source URI/revision;
- artifact name, size, media type, chunk size, and full SHA-256; and
- a contiguous ordered index of chunk ordinal, offset, size, and SHA-256.

The importer verifies the manifest signature before creating import metadata or byte
access. Each opened chunk must match the signed index. Replaying the same
operation key resumes at PostgreSQL's next ordinal; a transient reader failure
leaves the import resumable, while signature or checksum failure marks it failed
and reclaims unreferenced chunks. The source adapter is closed on every outcome.

## Protected content-addressed storage

Chunk keys are deterministic:

```text
models/chunks/sha256/<64 lowercase hexadecimal characters>
```

`EnvelopeModelChunkStore` accepts only the object service's
`envelope-encrypted` adapter. Every chunk is independently encrypted with an
AES-256-GCM data key, and each data key is wrapped by the versioned appliance
KEK. Reads authenticate encryption metadata, ciphertext, plaintext size, and
plaintext SHA-256. A plaintext filesystem/S3 adapter cannot be connected at
construction time.

Migration 20 independently checks that a cache chunk points to an
`objects.encrypted_blobs` row with the exact content-addressed key, plaintext
size, plaintext digest, AES-256-GCM data algorithm, and wrapped-key algorithm.
PostgreSQL contains only digests, encrypted-blob references, state, accounting,
and non-secret provenance—not model bytes, source credentials, or encryption
keys. A bounded reconciliation query discovers encrypted model blobs that were
written but never claimed after a crash.

## Actual writes, deduplication, and eviction

Beginning or resuming an import does not pre-charge its declared model size.
The cache records only actual committed, unique chunk bytes. Recording a new
chunk atomically checks the configured storage-account limit and increments
actual usage; an already present digest adds no bytes. Concurrent imports do
not block each other merely because their declared sizes exceed free space.
If an actual write cannot fit, verified progress remains resumable and no
existing model is deleted. Identical ready digests complete without transfer.
Migration 118 removes the obsolete counters without changing imported chunks,
active offsets, encryption metadata or published artifacts. Real physical
disk-full errors and the existing actual-write limits remain explicit.

Eviction is least-recently-used across `ready` artifacts and skips pinned or
actively leased artifacts. Removing an artifact releases a physical chunk only
when no other ready artifact or active import references it. Re-importing an
evicted digest reconstructs its ordered references and promotes it normally.
Deletion of metadata is committed before the service deletes the corresponding
encrypted bytes, making a retry safe; orphan reconciliation covers the inverse
crash window.

## Failure and observability rules

- Integrity, signature, range, or source-stability failures are fail-closed.
- Transport/read failures are retryable and preserve exact progress.
- Audit events contain actor, candidate, digest, byte count, deduplication,
  signature result, and reclaimed byte facts only.
- API-visible import records omit the idempotency operation key and signature
  bytes; storage blob keys remain an internal repository concern.
- Model cache data remains separate from user/team object namespaces and their
  quotas.
