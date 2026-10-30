# Comparable model benchmark harness

The benchmark harness separates measured facts from comparison claims. Every
run begins with an immutable plan that pins the profile and deployment,
environment and protected input-set digests, digest-addressed runner,
monotonic telemetry contract, warmup policy, error budget, and exact workload
matrix.

## Workload coverage

A valid inference plan includes cold and warm paths, batch scaling,
concurrency scaling, and at least one long-context token workload. Every
scenario fixes input class, result kind, local/managed/external target class,
codec mode, batch, concurrency, context/output lengths, warmups, measured runs,
and timeout. Warmups are recorded but excluded from aggregates.

The harness captures:

- model load time, first-result latency, and token TTFT;
- result and token throughput;
- peak unified memory and mean CPU;
- disk read/write and network receive/transmit bytes;
- accelerator utilization and peak codec encode/decode sessions;
- peak temperature and power;
- completed requests, error rate, and classified retryable/terminal errors;
- one protected raw-evidence object per scenario.

Latency uses median, throughput/utilization use mean, peak resources use
maximum, and byte counters use sum. These aggregation rules are part of the
implementation digest. Warmup samples cannot leak into measured aggregates,
and the collector enforces the exact planned run count and order.

## Unknown and non-applicable metrics

Every metric is present as `measured`, `not_applicable`, or `unsupported`.
External providers must report internal CPU, unified memory, disk, accelerator,
temperature, power, and cold-load telemetry as unsupported. A missing driver
temperature/power metric on a local node may also be unsupported with a stable
reason. Unsupported values can never be represented as numeric zero. Codec and
token metrics are not applicable only when the scenario declares that they are
not used.

## Comparison boundary

Profiles may differ, but comparison facts must be identical: benchmark key and
version, protected input-set digest, environment digest, runner image and
implementation, telemetry interval/clock/warmup policy, and the complete
scenario matrix. Both reports must be complete and metric support must match.
Only then does the comparer emit absolute and relative per-scenario deltas,
including errors. Otherwise it returns explicit mismatch reasons and no deltas.

The report and raw runs are content addressed. The model validation Benchmark
stage can pass only when the suite/input/profile/report digests, comparison key,
completion outcome, and zero failed-scenario count match its immutable plan.
