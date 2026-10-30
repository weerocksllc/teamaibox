# Historical initial model soak validation

This document records an older qualification protocol, not current appliance
startup or admission rules. Its fixed memory floor is retired. Existing
evidence is retained as historical evidence, not rerun or used to deny work.

OpenSpec task: `7.13`

The initial-certification soak is selected by
`models/model-soak-suite.v1.json`. The BF16 profile remains the high-precision
reference but is not an initial certification candidate because its worst
fault-stage cold-load sample retained only 157,081,600 bytes above the core
service reserve. The NVFP4 profile is critical, high-unified-memory, and NVFP4,
so its single required run is exactly 86,400 seconds. That run also exceeds the
eight-hour minimum for every selected initial certified profile.

## Evidence boundary

- The model snapshot, ARM64 vLLM image, deployment profile, suite,
  configuration, and exact probe source are bound by independent SHA-256
  digests before the test clock starts.
- Every run creates a fresh, owned vLLM compile-cache volume. Compile output is
  not reused across validation runs; this prevents a stale or incompatible
  CUDA/Triton artifact from affecting the result.
- The probe and model share only an internal Docker network. No model endpoint
  is published to the LAN. The probe is non-root, read-only, capability-free,
  and cannot access the Internet.
- A FULL-synchronous SQLite WAL journal records deterministic logical job IDs.
  Atomic checkpoints and minute resource samples survive supervisor loss.
- Prompts and generated output are never stored. Evidence contains counts,
  timings, token counts, sequence digests, resource measurements, and failure
  classifications only.
- Passing soak evidence remains non-certifying. Coexistence, security, and the
  final release gates still have to pass.

## Workload and gates

One short OpenAI-style request is scheduled every five seconds. Every twelfth
logical position adds a two-request long-context burst at concurrency two. The
test requires zero failed, lost, duplicated, incomplete, or health-failed work;
zero worker crash/restart/OOM; at least 12 GiB available for core services;
memory growth no greater than 4 GiB or 512 MiB/hour; temperature no greater
than 90°C; throughput degradation no greater than 20%; and p95 latency growth
no greater than 50%.

## Run and monitor

Launch the immutable formal run without keeping an SSH terminal attached:

```text
python3 tools/run_spark_model_soak.py \
  --profile-key llm.qwen36-35b-a3b.nvfp4.spark-32k.v1 \
  --run-id soak-20260811-nvfp4-24h-a2 \
  --detach
```

Read-only monitoring verifies the launch and checkpoint digests, lineage,
container ownership, evidence/runtime-volume ownership, progress, job counts,
memory reserve, and premature exit:

```text
python3 tools/check_spark_model_soak.py \
  --run-id soak-20260811-nvfp4-24h-a2
```

After the checkpoint deadline, collect final evidence and perform exact
cleanup:

```text
python3 tools/run_spark_model_soak.py \
  --profile-key llm.qwen36-35b-a3b.nvfp4.spark-32k.v1 \
  --run-id soak-20260811-nvfp4-24h-a2 \
  --resume

python3 tools/validate_model_soak_evidence.py
```

An interrupted supervisor may use `--resume` because the evidence volume is
durable. Never relaunch under the same run ID. A stopped probe, failed digest,
missing sample coverage, core-reserve breach, or cleanup residual fails the
run; elapsed time from an aborted or incomplete run is not combined with a
later run.
