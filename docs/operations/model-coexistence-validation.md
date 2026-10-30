# Historical initial model coexistence validation

This records an older qualification protocol. Its fixed core-memory floor is
retired and must not be used as an appliance startup or admission gate. Retain
past evidence without repeating already accepted business tests.

OpenSpec task: `7.14`

`models/model-coexistence-suite.v1.json` defines the bounded real-Spark test
that follows the successful 24-hour NVFP4 soak. The runner fails before making
an SSH connection unless the exact formal soak report passes its strict
validator; smoke, aborted, incomplete, or digest-drifted soak evidence cannot
unlock this stage.

## What the two phases prove

1. `shared-capabilities` runs drawing, OCR, ASR, translation, and realtime
   speech reservation resource envelopes together. Each has a distinct owned
   container, cgroup, deterministic capability endpoint, and candidate-model
   reference. All seven core-service domains are probed concurrently through
   real identity-session, administrator-authorization, Team Drive
   list/search/quota, protected-object metadata, messaging send/history/search,
   PostgreSQL readiness, and JetStream health operations.
2. `node-exclusive-llm` cooperatively drains every shared worker and the
   realtime reservation before loading the exact NVFP4 LLM profile. A separate
   24-GiB resident pressure cgroup forces a bounded unified-memory pressure
   condition while OpenAI-style LLM requests and core probes continue.

The drawing/OCR/ASR/translation containers in this stage validate conservative
scheduler envelopes, lifecycle, drain, cgroup isolation, realtime protection,
and core-service coexistence. They do not claim model output quality. Actual application inference is covered by tasks 8.2–8.5. The LLM phase does run the immutable model artifact and verifies
its NVFP4/Marlin/FlashInfer runtime identity.

## Safety and acceptance

- The runner creates one run-scoped internal network, one fresh runtime cache,
  exact labeled containers, and one exact `/tmp` staging directory. It does not
  publish an AI or validation port to the LAN.
- Capability workers are non-root, read-only, capability-free, network-isolated
  from the Internet, and bounded by exact memory/CPU/PID cgroups.
- Evidence binds every worker and cooperative drain to its exact run-scoped
  container name and immutable container ID.
- The seven core-service containers are independently bound to their exact
  64-hex Docker IDs, roles, owner/run labels, internal network, running state,
  and disabled restart policy before saturation. The same identities must
  remain running after all two phases; replacement, restart, duplication, or
  cross-run substitution fails validation.
- Each probe report declares the operation class for every core domain. The
  task-10.7 domains must be functional operations—identity authentication and
  session validation, administrator authorization, Team Drive
  list/version/search/quota, message send/history/search, and protected-object
  put/head/list—not generic health responses. The declaration and executable
  probe source are both bound by the staged-source digest.
- Core readiness is established before timed probing, including TCP readiness
  for PostgreSQL and JetStream health for NATS.
- Every phase requires zero capability failures, zero core failures, zero
  crash/restart/OOM, the 12-GiB core reserve, temperature at or below 90°C, and
  p95 core latency at or below 1,000 ms. Realtime p95 must remain at or below
  250 ms.
- The LLM phase must actually cross their bounded pressure
  thresholds; a lightly loaded run cannot pass by omission.
- Prompts and model output are reduced to digests inside the disposable probe.
  No prompt or generated output text enters evidence.

## Execute and validate

Only run after `tools/validate_model_soak_evidence.py` passes:

```text
python3 tools/run_spark_model_coexistence.py \
  --run-id coexist-20260812-a1

python3 tools/validate_model_coexistence_evidence.py
```

The final validator recomputes the report, suite, runner source, exact source
aggregate copied to Spark, resource samples, scheduler source/output,
formal-soak lineage, worker runtime/security boundaries, phase coverage, and
cleanup gates.
Passing coexistence evidence remains non-certifying: security and final release
gates still apply.
