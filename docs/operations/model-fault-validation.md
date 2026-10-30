# Release-candidate model fault validation

OpenSpec task: `7.12`

The fault stage is fail-closed and runs against every profile listed by
`models/model-fault-suite.v1.json`. The suite is bound to the canonical digest
of `deploy/compute/model-baseline-deployments.v1.json`; adding, removing, or
changing a profile invalidates the suite until its complete fault plan is
reviewed again.

## Boundaries

- Model snapshots and the vLLM runtime use exact revisions and OCI digests.
- The live worker and probes share only the owned internal Docker network; no
  model port is published to the LAN and the probes have no external network.
- Generated text and prompts are never written to evidence. Only response
  digests, counts, timings, status codes, and bounded failure classifications
  are retained.
- The OOM case uses the exact model profile in an intentionally undersized
  8-GiB disposable cgroup. It never induces host-wide memory exhaustion. The
  Web health endpoint must survive, and the full profile must reload and
  reproduce the pre-fault integrity digest.
- Worker restart uses `SIGKILL` and requires a non-OOM exit classification,
  readiness of the same container, and matching integrity. Cold reload removes
  that container and requires a new identity.
- Node Agent restart evidence comes from a real ARM64 mTLS boundary run. Exact
  replay may recover an existing worker only if command digest, image, profile,
  attempt, lease, and fence all match.
- Queue replay and cooperative cancellation are re-run from the durable job and
  scheduler contract suites and bound by output digest into each profile run.

## Validation commands

```text
python3 tools/validate_model_fault_suite.py

python3 tools/run_spark_model_faults.py \
  --profile-key llm.qwen36-35b-a3b.bf16.spark-reference-32k.v1 \
  --run-id faults-20260811-bf16-a1

python3 tools/run_spark_model_faults.py \
  --profile-key llm.qwen36-35b-a3b.nvfp4.spark-32k.v1 \
  --run-id faults-20260811-nvfp4-a1
```

Each runner verifies the hardware/runtime identity, model-volume ownership,
artifact manifest, profile/deployment fingerprints, core Web health, and exact
cleanup. A run remains non-certifying: successful fault evidence is necessary
but does not replace the soak, coexistence, security, or final certification
stages.
