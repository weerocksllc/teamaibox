# Persistence

PostgreSQL schemas, migrations, repositories, transaction boundaries, and
outbox/inbox primitives. This package owns persistence mechanics, not service
business decisions or an alternative in-memory truth.

Migration sources are ordered and checksummed by migrations/manifest.json.
Validate them with tools/validate_migrations.py. Apply them with
tools/apply_migrations.py using standard libpq/psql environment variables; do
not place database passwords in command-line URLs.

Every schema-qualified identity foreign key targets the foundation
`iam.identities` table. The post-soak Spark qualification applies the complete
checksummed catalog to a disposable locked PostgreSQL 18 ARM64 container before
the durable Platform API identity/restart journey; static checksum validation
alone is not release evidence.

Down migrations exist for disposable development and tested recovery planning.
They are destructive and are never applied automatically to appliance data.

`src/postgres-database.mjs` is the shared Node runtime adapter. It uses the
exact locked `pg` package, parameterized queries, a bounded pool, a dedicated
client for every transaction, explicit commit/rollback, and destructive client
release after a failed transaction. Configuration rejects connection URLs and
reads the password lazily from an absolute secret-file path. Verified TLS is
the default; plaintext transport must be an explicit composition decision for
the isolated single-host Docker data network. Services call `ready()` before
opening their public boundary and close the pool during bounded shutdown.

Object ciphertext is addressed by `objects.encrypted_blobs.blob_key`. PostgreSQL
stores authenticated encryption metadata and a wrapped per-blob data key only;
plaintext data keys, wrapping keys, and object content are never persisted there.
Wrapping-key rotation advances the row revision while immutable ciphertext
metadata is protected by a database trigger.

Migration 8 separates physical encryption metadata, blob claims, immutable
object versions, and file metadata versions. Database triggers make verified
claim consumption and current-version advancement part of the same transaction;
unverified or cross-namespace references fail before a partial version becomes
visible. Expired staged claims, abandoned multipart parts, and explicitly
reclaimable claims are exposed through a bounded reconciliation query.

Migration 11 implements the durable compute queue projection and quota-policy
records. Job rows contain scheduling facts, SHA-256 request identity, ordered
progress, normalized terminal state, and encrypted object/artifact references;
they do not contain prompt, media, generated-result, credential, or raw provider
payloads. The application repository performs idempotency and quota checks with
transaction-scoped owner/capability locks before inserting the initial event.

Migration 20 implements the protected model artifact cache. It stores resumable
import offsets, quota reservations, unique content-addressed chunks, ready
artifacts, and ordered chunk mappings. The database verifies every chunk against
matching AES-256-GCM envelope metadata in `objects.encrypted_blobs`; its atomic
record/finalize/fail functions keep progress, deduplication, quota conversion,
promotion, and reclamation coherent under concurrent platform processes.

Migration 21 adds reproducible model engine build and deployment jobs. Exact
canonical specifications and fingerprints are immutable; worker claim tokens
are hashed, terminal results are immutable digest attestations, operation aliases
retain idempotency across content deduplication, and a database trigger permits
deployment only from the exact outputs of a successful build.

Migration 22 records immutable ten-stage model validation plans and evidence.
It proves profile/build/deployment lineage on insert, hashes stage claim tokens,
advances one stage at a time, blocks all remaining stages after failure, and
permits `certified` only after the final ordered stage passes.

Migration 31 adds Team Drive metadata independently from encrypted object
blobs: user/team roots, folder hierarchy, retained recycle state, inherited
ACLs, expiring internal shares, immutable object-version-backed file history,
preview metadata, and root quota accounting. Database boundaries reject cycles,
sibling conflicts, stale version order, quota overflow, and object-fact drift.

Historical migrations 1 through 104 remain immutable, including schemas for
retired multi-appliance operations. They preserve upgrade checksums, existing
records and recovery history; their presence does not enable those operations
in the single-appliance product. Do not rewrite their source, drop retained
records or manufacture legacy configuration to start a new installation.

Migration 105 binds casting sessions to `compute.nodes.id` through
`appliance_node_id`. Existing sessions are mapped only when their historical
ownership resolves to exactly one appliance; an ambiguous mapping aborts without
changing data. New sessions require browser-only output and both `cast:use` and
`cast:view`. Legacy session lifecycle records remain readable and stoppable.
Runtime execution must still match the configured `PLATFORM_APPLIANCE_NODE_ID`;
a retained foreign node record never authorizes execution on another machine.

The active SQL smoke suite uses isolated local appliance identities, browser
casting, authorization and persistent office-set transactions. Each smoke rolls
back its fixtures. Retired orchestration/onboarding smokes are not current
acceptance requirements. Migration checksum validation and source-level tests
do not prove PostgreSQL execution: run `tools/ci_database_smoke.py` against the
locked disposable ARM64 PostgreSQL image before deployment acceptance.
