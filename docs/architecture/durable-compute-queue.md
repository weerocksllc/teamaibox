# Durable compute queue

Every non-realtime Compute API call crosses one durable acceptance boundary
before a scheduler, local worker, or optional external API provider can observe it.
Realtime sessions use their own authenticated lifecycle without advance resource booking.

## Acceptance transaction

1. Authenticate the caller and resolve an enabled logical capability.
2. Canonicalize the request and scheduling facts. The SHA-256 covers the
   operation, model/profile, data class, priority, deadline, and request body.
3. For an idempotent call, look up the owner + operation scope + key. Matching
   facts return the existing job; changed facts fail with
   `idempotency_conflict`.
4. Persist the request JSON through the protected object service. Envelope
   encryption occurs before the job stores its immutable artifact reference.
5. In one PostgreSQL transaction, take owner and capability advisory locks,
   recheck idempotency, enforce queue/active/daily/request-size quotas, insert
   the job, and append its first resumable event.
6. Only after commit may the execution bridge wake or dispatch work.

`PostgresDurableJobRepository` implements the appliance transaction boundary.
`MemoryDurableJobRepository` is a deterministic conformance fake for unit tests
and is never the production source of truth.

## Durable state

Migration 11 extends `compute.jobs` with operation, immutable response identity,
model profile, route class, request digest/size/artifact, data class, progress
revision/sequence/value, waiting reason, retry classification, encrypted result
artifact reference, normalized terminal error, correlation key, and replay
count. `compute.job_events` remains the ordered cursor stream. The database does
not store prompt, media, generated content, or raw upstream errors in job
metadata.

The scheduler-visible lifecycle is:

`queued → admitted/preparing → running → succeeded|failed|cancelled|expired|incomplete`

- Progress is monotonic inside a revision and has an ordered event sequence.
- A queued/admitted/preparing cancellation becomes terminal immediately.
- A running cancellation records intent; the worker acknowledges cooperative
  cancellation before the job becomes `cancelled`.
- An expired pre-dispatch deadline becomes `expired`. A running job whose
  deadline passes becomes `incomplete` with `manual_reconcile`, because side
  effects or provider acceptance may be uncertain.
- Terminal success stores a typed result schema and encrypted output artifact.
  Retrieval reads and verifies the protected object; the job row keeps only the
  reference and integrity facts.

## Quota and priority

The v1 policy limits per-owner queued and active work, per-capability queued
work, per-owner rolling daily submissions, and serialized request size.
`compute.job_quota_policies` persists versioned appliance/owner/capability
policy records. Priority remains an integer from 0 to 100, but it cannot bypass
quota admission; scheduler fairness and scoring are task 5.4.

## Retry boundary

Failures are normalized as `retryable`, `terminal`, or `manual_reconcile`.
`retryable` means a later attempt may be created under scheduler policy; it does
not silently replay a request. `manual_reconcile` means output or side effects
may already exist and blind automatic replay is forbidden. Provider-specific
attempt acceptance and replay safety remain in the v1 Attempt and ProviderError
contracts.

