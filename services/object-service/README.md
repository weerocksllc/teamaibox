# Object Service

Protected object byte plane for upload, multipart resume/abort, range download,
versions, lifecycle, quotas, hashes, scoped references, blob-store adaptation,
and envelope encryption.

Object metadata commits through platform persistence boundaries; plugins and
workers use short-lived grants and never receive permanent object credentials
or plaintext key material.

The v1 service boundary implements one-shot and resumable multipart upload,
part listing/replacement/abort/complete, immutable version hashes, full/range
download, head/list/version/delete, quota reservation, retention lifecycle,
short-lived HMAC-signed references, and an internal S3 operation adapter.
Namespace ownership is checked on every direct operation; richer team ACL and
worker grants are layered in task 4.4.

`MemoryBlobStore` is an explicitly test-only plaintext adapter. Production
construction rejects it unless the test-only flag is passed.

`EnvelopeEncryptedBlobStore` is the production data-plane boundary. Every blob
receives a random 256-bit data-encryption key and AES-256-GCM nonce. The DEK is
wrapped by a versioned KEK obtained through `ProtectedSecretEnvelopeKeyring`;
neither plaintext key is persisted. Blob identity, sizes, hashes, cipher
metadata, and key version are authenticated as associated data. KEK rotation
rewraps the small DEK envelope without rewriting the object ciphertext, and
generated/unwrapped DEK buffers are zeroed in `finally` boundaries.

PostgreSQL migration 7 persists only authenticated encryption metadata and the
wrapped DEK. Its trigger makes ciphertext metadata immutable across rewraps and
requires monotonic metadata revisions.

Object publication uses a staged-claim transaction: bytes are stored, registered,
read back, and hash/size verified before a metadata transaction may publish an
immutable object version. Multipart parts use the same verified claims. Failed
commits remain invisible and become reclaimable; reconciliation handles both
registered failures and sufficiently old physical blobs that never obtained a
claim, while preserving a grace window around active writes.

PostgreSQL migration 8 persists namespaces, upload/part state, blob claims,
object entries/versions, and the independent file entry/version link. Triggers
atomically consume a verified claim when an object version commits and require
file versions to reference a verified immutable object version in the same
namespace. The database exposes bounded orphan candidates for lifecycle work.

Production namespace access is an explicit operation grant over a `tenant:`,
`user:`, or `team:` namespace. A bare caller-supplied namespace key is accepted
only behind the test compatibility switch. Worker, plugin, and service-account
identities cannot use direct object methods even if they claim a matching key.

Worker access uses short-lived signed references backed by server-side grant
records. The record binds one immutable object version, audience, exact
head/read/range operations, digest, issuer, and a maximum 15-minute expiry. It
stores no token or storage credential and can be revoked immediately by the
issuer or an authorized namespace administrator. Successful and denied direct
or reference access produces redacted audit events without the signed token.

PostgreSQL migration 9 persists namespace bindings, revocable access-grant
facts, and append-only object access events. It derives namespace kind,
validates closed operation sets, checks issuer authority/object namespace/hash,
and prevents grant scope mutation after issuance.

`StoragePoolService` is the administrator-only storage control plane. It keeps
an inventory of local block, local filesystem, and S3-compatible pools; reports
observed health, freshness, capacity, reservations, allocations, and safety
reserve; and admits placement only to compatible, healthy, freshly observed
encrypted pools. Local pools require verified LUKS2, while S3-compatible pools
require verified provider-managed encryption. Every physical copy remains
inside the envelope-encryption boundary described above.

Placement reservations use a closed data-class catalog, exact size/SHA-256,
bounded lifetime, and distinct failure domains for multiple availability
copies. A reservation becomes committed only after every target has an exact
verification result. These copies are explicitly reported as availability
copies with `verifiedBackup: false`; storage capacity is not backup evidence.

Pool inventory obtains its separate `backup` projection through a backup-state
provider. The projection reports status, verified copy count, independent
target count, last verification time, and always has `capacityIncluded: false`.
If that provider is absent or invalid the state is `unavailable`, never inferred
from online allocations. See `docs/architecture/storage-vs-backup.md` for the
operator-facing distinction and future backup-service integration contract.

Draining stops new placement, copies or reuses an eligible target, inspects the
target, and only then deletes the source. A verification mismatch retains the
source. A failed source deletion remains `cleanup_pending` and is resumable.
Removal is a logical inventory transition and is blocked until the pool is
drained with no allocations, active reservations, or incomplete migrations;
unique-copy blob keys are reported as explicit blockers.

PostgreSQL migration 10 persists pools, allowed data classes, placement
reservations/targets, verified allocations, and migration state. Database
triggers independently enforce encrypted-blob integrity, eligibility,
failure-domain separation, migration verification/state transitions, and safe
drain/removal. Physical discovery, mounting, LUKS lifecycle, and backup
verification remain separate privileged adapters and workflows; this service
does not mutate disks.

## Team Drive metadata

`TeamDriveService` and its memory/PostgreSQL repositories keep file hierarchy
and access metadata independent from protected blob storage. User and team
roots enforce quota; folders and files use optimistic revisions; every file
version binds immutable object ID/version, size, media type, SHA-256 and bounded
provenance facts. The service resolves only short-lived upload references and
never stores them.

Inherited identity/team ACLs, expiring internal shares, permission-scoped
search, supported-media preview references, retained recycle state, conflict-
checked restore and post-retention purge are fail-closed. PostgreSQL migration
31 repeats the hierarchy, object-fact, version-order and quota boundaries in
the database transaction layer.

`ArtifactProvenanceService` is the durable handoff layer above scoped object
references. It verifies the exact issuer, audience, operation, expiry, object
version, size, media type and SHA-256 before recording immutable provenance.
Stored records contain stable object facts and source edges, never the
short-lived reference ID, signed token, storage credential or plaintext key.
Consumers receive a newly issued, audience-bound reference only when access is
needed.

`TeamDriveArtifactHandoff` converts an uploaded or AI-produced object into a
`drive-file` provenance record when a file version is committed. Existing AI
lineage is retained through an `export-of` edge. Client-supplied provenance is
explicitly retained only as untrusted `clientAnnotations`; it cannot replace
the verified producer, object or source facts. PostgreSQL migration 33 stores
the immutable provenance graph and append-only, redacted handoff events.

See `docs/architecture/scoped-artifact-handoffs.md` for the audience matrix and
cross-application lifecycle.
