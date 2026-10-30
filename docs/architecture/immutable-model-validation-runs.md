# Immutable model validation runs

Certification evidence is produced by one immutable, ordered validation plan.
The plan binds an immutable ModelProfile, successful reproducible engine build,
successful deployment, test-corpus digest, policy digest, and ten stage
specifications into one SHA-256 fingerprint.

## Required stage order

Every run contains exactly:

1. Discovery
2. Build
3. Smoke
4. Conformance
5. Quality
6. Benchmark
7. Stress/Soak
8. Local coexistence
9. Security
10. Certification

No stage can be omitted, duplicated, reordered, or claimed before the previous
stage passes. Each specification pins a digest-addressed ARM64 executor image,
suite digest, configuration digest, timeout, exclusive-resource decision, and
the complete required evidence-kind set.

## Execution and evidence

Only administrators with `model:manage` create runs. Workers need
`model:validate` and receive a short-lived stage claim. Claim tokens are exposed
once and stored as SHA-256 only. A result repeats the plan/stage/executor/suite/
configuration identity and records outcome, environment, metrics and log
digests, start/finish timestamps, and all declared evidence objects.

Each evidence item has kind, SHA-256, byte size, media type, and an immutable
`object://` reference. The service verifies the object against protected storage
before PostgreSQL can commit the result. Evidence bytes and credentials never
enter validation metadata or audit events.

`passed` advances exactly one stage. `failed` or `incomplete` makes the run
failed and permanently blocks every downstream stage. A corrected experiment
uses a new run key and plan fingerprint; it never overwrites failed evidence.
Only a passing Certification result after the nine prior passing results makes
the run `certified`.

## Database enforcement

Migration 22 verifies at insertion that profile/build/deployment fingerprints
match immutable successful database records and that deployment belongs to the
same build. It validates all ten ordered stages in the plan, stores operation
aliases for idempotent deduplication, and permits only:

```text
pending -> queued -> running -> passed | failed | incomplete
pending -> blocked
validating -> certified | failed
```

The transactional completion function locks the run and current stage, checks
the unexpired worker fence and plan identity, writes the immutable result, then
either queues exactly one successor or blocks all successors. Terminal stage
and run evidence cannot be edited or deleted through the workflow.

