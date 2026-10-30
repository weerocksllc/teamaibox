# Model registry boundary

- `model-profile-registration-service.mjs` validates and registers exact,
  immutable v1 deployment identities. Only identities with `model:manage` may
  call it.
- `memory-model-profile-repository.mjs` provides deterministic unit-test and
  embedded-development behavior.
- `postgres-model-profile-repository.mjs` serializes registration with
  advisory locks and atomically writes the searchable projection plus the
  immutable document.

Callers must not edit a profile in place. Register a new `profileKey` for every
artifact, engine, runtime, recipe, compatibility, policy, or resource change.
Certification and production routing are intentionally not granted during
registration.

Lifecycle and routing eligibility components:

- `model-lifecycle-service.mjs` enforces the Experimental, Validating,
  Certified, Deprecated, Failed, and Revalidation Required state machine.
  Certification requires an exact immutable profile fingerprint and a fully
  passed validation run; a stale environment cannot remain routable as
  Certified.
- `memory-model-lifecycle-repository.mjs` is the deterministic state-machine
  reference. `postgres-model-lifecycle-repository.mjs` locks the profile,
  increments a revision, and appends the lifecycle event atomically.
- production routing admits only Certified profiles. An administrator may
  enable one exact Experimental profile only in a named `development` or
  `validation` policy, and every opt-in expires within 30 days.
- `model-report-service.mjs` derives administrator-readable model cards,
  environment compatibility matrices, validation-stage/raw-evidence links,
  NVFP4-versus-baseline comparisons, known limitations, and fail-closed
  routing recommendations from the immutable profile and validation evidence.
- `postgres-model-report-catalog.mjs` joins registration, lifecycle, and
  validation projections, and reads bounded comparison documents only through
  a protected digest-aware evidence reader. `model-administration.mjs`
  composes that catalog with the lifecycle/report HTTP boundary.
- administrator list/card reads accept `model:view` or `model:manage` through
  the local authenticated session. Lifecycle and experimental-routing writes
  still require `model:manage` plus CSRF and do not reuse AI invocation
  credentials.
- `model-revalidation-service.mjs` records the exact Certified artifact,
  quantization, engine, container, driver, OS/kernel, CUDA, Container Toolkit,
  hardware, configuration, and corpus baseline. Any changed or unknown fact
  atomically moves a Certified profile to Revalidation Required before it can
  be selected again.

Artifact import and cache components:

- `model-artifact-import-service.mjs` implements the administrator-only online
  and signed-offline import state machine, full-artifact verification, cache
  pin/lease operations, and LRU eviction.
- `https-model-range-source.mjs` performs bounded HTTPS Range requests and
  fail-closed redirect/validator checks.
- `envelope-model-chunk-store.mjs` is the only model byte-plane adapter. It
  requires object-service envelope encryption and uses content-addressed keys.
- `memory-model-artifact-repository.mjs` is the executable unit-test reference
  for quota, deduplication, resume, and shared-chunk reclamation behavior.
- `postgres-model-artifact-repository.mjs` uses migration 20's transactional
  functions and row/advisory locks for multi-process production behavior.

No component may concatenate a complete model artifact in memory or expose a
plaintext blob adapter as model storage.

Reproducible engine workflow components:

- `model-engine-job-service.mjs` canonicalizes and fingerprints exact build and
  deployment specifications, verifies protected inputs/outputs, and validates
  fenced worker attestations.
- `memory-model-engine-job-repository.mjs` is the deterministic state-machine
  reference used by unit tests.
- `postgres-model-engine-job-repository.mjs` stores only claim-token hashes and
  uses migration 21's immutable transition and successful-build deployment
gates.

Validation pipeline components:

- `model-validation-service.mjs` fixes the ten-stage validation sequence,
  verifies ModelProfile/build/deployment lineage and protected evidence, and
  accepts only fenced worker results.
- `memory-model-validation-repository.mjs` provides the executable sequential
  and fail-closed reference state machine.
- `postgres-model-validation-repository.mjs` uses migration 22's immutable
  lineage, transition triggers, operation aliases, and atomic stage-completion
  function.

Task-quality components:

- `model-quality-service.mjs` canonicalizes versioned suite definitions,
  verifies exact corpus/profile/evaluator/seed/coverage facts, applies absolute
  and optional baseline-regression thresholds, and emits digest-addressed
  pass/fail reports.
- the validation service requires a quality-stage gate whose suite, corpus,
  profile, report digest, outcome, and failed-measurement count agree with the
  immutable validation plan. Missing or contradictory quality evidence cannot
  advance Certification.

Comparable benchmark components:

- `model-benchmark-service.mjs` validates a pinned cold/warm, batch,
  concurrency, and long-context plan; collects measured runs while excluding
  warmup; aggregates latency, throughput, resource, codec, thermal, power, and
  classified error evidence; and emits a digest-addressed report.
- report comparison produces deltas only when workload, input set, environment,
  runner, telemetry, scenario matrix, and metric support are identical. A
  mismatch is an explicit non-comparable result, never a misleading chart.
- the validation Benchmark stage requires a complete matching report before it
  may advance.
