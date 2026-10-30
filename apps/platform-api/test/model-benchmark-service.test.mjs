import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  compareModelBenchmarkReports,
  evaluateModelBenchmark,
  MODEL_BENCHMARK_METRICS,
  ModelBenchmarkHarness,
  modelBenchmarkPlanDigest,
  normalizeModelBenchmarkPlan,
} from "../src/models/model-benchmark-service.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const implementation = `sha256:${createHash("sha256").update(await readFile(
  new URL("../src/models/model-benchmark-service.mjs", import.meta.url),
)).digest("hex")}`;

function scenario(overrides = {}) {
  return {
    scenarioKey: "warm-single-short",
    inputClass: "short-instruction",
    resultKind: "token_stream",
    targetKind: "local",
    codecMode: "none",
    coldStart: false,
    batchSize: 1,
    concurrency: 1,
    contextTokens: 512,
    outputTokens: 128,
    longContext: false,
    warmupRuns: 3,
    measuredRuns: 5,
    timeoutSeconds: 600,
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    benchmarkKey: "performance.llm-inference",
    version: "1.0.0",
    profileFingerprint: digest("a"),
    deploymentFingerprint: digest("b"),
    environmentDigest: digest("c"),
    inputSetDigest: digest("d"),
    runner: {
      image: `docker.io/library/node@${digest("e")}`,
      implementationDigest: implementation,
    },
    telemetry: {
      schemaVersion: 1,
      sampleIntervalMilliseconds: 200,
      warmupExcluded: true,
      clock: "monotonic",
    },
    scenarios: [
      scenario({ scenarioKey: "cold-single-short", coldStart: true, warmupRuns: 0 }),
      scenario(),
      scenario({ scenarioKey: "warm-batch-four", batchSize: 4, codecMode: "transcode" }),
      scenario({ scenarioKey: "warm-concurrency-four", concurrency: 4 }),
      scenario({ scenarioKey: "warm-long-context", inputClass: "long-context", contextTokens: 32768, outputTokens: 512, longContext: true, timeoutSeconds: 1800 }),
    ],
    acceptance: { maximumErrorRate: 0.01, minimumCompletedRequests: 3 },
    ...overrides,
  };
}

function metric(metricKey, currentScenario, overrides = {}) {
  const notApplicable = (!currentScenario.coldStart && metricKey === "load_time_ms")
    || (currentScenario.resultKind !== "token_stream" && ["ttft_ms", "token_throughput_per_second"].includes(metricKey))
    || (metricKey === "codec_encode_sessions_peak" && !["encode", "transcode"].includes(currentScenario.codecMode))
    || (metricKey === "codec_decode_sessions_peak" && !["decode", "transcode"].includes(currentScenario.codecMode));
  if (notApplicable) return { status: "not_applicable", reason: "metric_not_applicable", ...overrides };
  const externalResource = currentScenario.targetKind === "external_provider"
    && ["load_time_ms", "peak_unified_memory_bytes", "cpu_percent_mean", "disk_read_bytes", "disk_write_bytes", "accelerator_utilization_percent_mean", "temperature_celsius_peak", "power_watts_peak"].includes(metricKey);
  if (externalResource) return { status: "unsupported", reason: "external-provider-telemetry-unavailable", ...overrides };
  const integerMetric = MODEL_BENCHMARK_METRICS[metricKey].kind === "integer";
  const percentMetric = MODEL_BENCHMARK_METRICS[metricKey].kind === "percent";
  return { status: "measured", value: integerMetric ? 1024 : percentMetric ? 45 : 12.5, ...overrides };
}

function execution(inputPlan, { mutateScenario = (value) => value, mutateMetric = (value) => value } = {}) {
  const normalized = normalizeModelBenchmarkPlan(inputPlan);
  return {
    planDigest: modelBenchmarkPlanDigest(inputPlan),
    profileFingerprint: normalized.profileFingerprint,
    deploymentFingerprint: normalized.deploymentFingerprint,
    environmentDigest: normalized.environmentDigest,
    inputSetDigest: normalized.inputSetDigest,
    runner: structuredClone(normalized.runner),
    scenarioResults: normalized.scenarios.map((currentScenario) => mutateScenario({
      scenarioKey: currentScenario.scenarioKey,
      completedRequests: currentScenario.measuredRuns,
      errorCount: 0,
      errors: [],
      metrics: Object.fromEntries(Object.keys(MODEL_BENCHMARK_METRICS).map((metricKey) => [
        metricKey,
        mutateMetric(metric(metricKey, currentScenario), metricKey, currentScenario),
      ])),
      rawEvidence: {
        digest: digest("f"),
        sizeBytes: 4096,
        mediaType: "application/json",
        reference: `object://model-benchmarks/${currentScenario.scenarioKey}`,
      },
    }, currentScenario)),
    startedAt: "2026-08-11T00:00:00.000Z",
    finishedAt: "2026-08-11T01:00:00.000Z",
  };
}

function evaluate(inputPlan, result) {
  return evaluateModelBenchmark({ plan: inputPlan, expectedPlanDigest: modelBenchmarkPlanDigest(inputPlan), result });
}

test("benchmark report captures the complete cold/warm performance and resource envelope", () => {
  const inputPlan = plan();
  const normalized = normalizeModelBenchmarkPlan(inputPlan);
  assert.equal(normalized.scenarios.some((item) => item.coldStart), true);
  assert.equal(normalized.scenarios.some((item) => item.batchSize > 1), true);
  assert.equal(normalized.scenarios.some((item) => item.concurrency > 1), true);
  assert.equal(normalized.scenarios.some((item) => item.longContext), true);
  const report = evaluate(inputPlan, execution(inputPlan));
  assert.equal(report.outcome, "completed");
  assert.deepEqual(report.failedScenarios, []);
  assert.match(report.planDigest, /^sha256:/);
  assert.match(report.comparisonKey, /^sha256:/);
  assert.match(report.reportDigest, /^sha256:/);
  for (const scenarioResult of report.scenarioResults) {
    assert.deepEqual(Object.keys(scenarioResult.metrics).sort(), Object.keys(MODEL_BENCHMARK_METRICS).sort());
    assert.equal(scenarioResult.metrics.first_result_ms.status, "measured");
    assert.equal(scenarioResult.metrics.ttft_ms.status, "measured");
    assert.equal(scenarioResult.metrics.peak_unified_memory_bytes.status, "measured");
    assert.equal(scenarioResult.metrics.temperature_celsius_peak.status, "measured");
    assert.equal(scenarioResult.rawEvidence.reference.startsWith("object://"), true);
  }
  assert.equal(report.scenarioResults.find((item) => item.scenarioKey === "cold-single-short").metrics.load_time_ms.status, "measured");
  assert.equal(report.scenarioResults.find((item) => item.scenarioKey === "warm-single-short").metrics.load_time_ms.status, "not_applicable");
  assert.equal(report.scenarioResults.find((item) => item.scenarioKey === "warm-batch-four").metrics.codec_encode_sessions_peak.status, "measured");
  assert.equal(report.scenarioResults.find((item) => item.scenarioKey === "warm-batch-four").metrics.codec_decode_sessions_peak.status, "measured");
});

test("benchmark harness excludes warmup and aggregates measured runs with pinned metric semantics", () => {
  const inputPlan = plan();
  const normalized = normalizeModelBenchmarkPlan(inputPlan);
  const harness = new ModelBenchmarkHarness(inputPlan);
  for (const currentScenario of normalized.scenarios) {
    for (let index = 0; index < currentScenario.warmupRuns; index += 1) harness.recordWarmup({ scenarioKey: currentScenario.scenarioKey });
    for (let index = 0; index < currentScenario.measuredRuns; index += 1) {
      harness.recordMeasured({
        scenarioKey: currentScenario.scenarioKey,
        outcome: "completed",
        metrics: Object.fromEntries(Object.keys(MODEL_BENCHMARK_METRICS).map((metricKey) => {
          const value = metric(metricKey, currentScenario);
          if (value.status !== "measured") return [metricKey, value];
          if (metricKey === "first_result_ms") return [metricKey, { status: "measured", value: 10 + index }];
          if (metricKey === "disk_read_bytes") return [metricKey, { status: "measured", value: 100 + index }];
          return [metricKey, value];
        })),
      });
    }
  }
  const report = harness.finalize({
    rawEvidence: normalized.scenarios.map((currentScenario) => ({
      scenarioKey: currentScenario.scenarioKey,
      digest: digest("7"),
      sizeBytes: 8192,
      mediaType: "application/json",
      reference: `object://model-benchmark-raw/${currentScenario.scenarioKey}`,
    })),
    startedAt: "2026-08-11T00:00:00.000Z",
    finishedAt: "2026-08-11T01:00:00.000Z",
  });
  assert.equal(report.outcome, "completed");
  for (const result of report.scenarioResults) {
    assert.equal(result.metrics.first_result_ms.value, 12);
    assert.equal(result.metrics.disk_read_bytes.value, 510);
    assert.equal(result.completedRequests, 5);
  }
});

test("benchmark harness enforces warmup/measured sequencing and exact run counts", () => {
  const inputPlan = plan();
  const harness = new ModelBenchmarkHarness(inputPlan);
  const currentScenario = normalizeModelBenchmarkPlan(inputPlan).scenarios.find((item) => item.scenarioKey === "warm-single-short");
  assert.throws(() => harness.recordMeasured({ scenarioKey: currentScenario.scenarioKey, outcome: "error", error: { classification: "worker-failure", retryable: true } }), { code: "benchmark_harness_sequence" });
  harness.recordWarmup({ scenarioKey: currentScenario.scenarioKey });
  harness.recordWarmup({ scenarioKey: currentScenario.scenarioKey });
  harness.recordWarmup({ scenarioKey: currentScenario.scenarioKey });
  assert.throws(() => harness.recordWarmup({ scenarioKey: currentScenario.scenarioKey }), { code: "benchmark_harness_sequence" });
});

test("external provider hardware metrics remain explicitly unsupported rather than fabricated as zero", () => {
  const externalPlan = plan({ scenarios: plan().scenarios.map((item) => ({ ...item, targetKind: "external_provider" })) });
  const report = evaluate(externalPlan, execution(externalPlan));
  const cold = report.scenarioResults.find((item) => item.scenarioKey === "cold-single-short");
  assert.equal(cold.metrics.load_time_ms.status, "unsupported");
  assert.equal(cold.metrics.peak_unified_memory_bytes.status, "unsupported");
  assert.equal(cold.metrics.accelerator_utilization_percent_mean.status, "unsupported");
  assert.equal(cold.metrics.network_receive_bytes.status, "measured");

  const fabricated = execution(externalPlan, {
    mutateMetric(value, metricKey) {
      return metricKey === "peak_unified_memory_bytes" ? { status: "measured", value: 0 } : value;
    },
  });
  assert.throws(() => evaluate(externalPlan, fabricated), { code: "benchmark_result_invalid" });
});

test("errors are retained and a scenario above the pinned error-rate budget fails the report", () => {
  const inputPlan = plan();
  const result = execution(inputPlan, {
    mutateScenario(value, currentScenario) {
      return currentScenario.scenarioKey === "warm-concurrency-four"
        ? { ...value, completedRequests: 4, errorCount: 1, errors: [{ classification: "worker-timeout", retryable: true, count: 1 }] }
        : value;
    },
  });
  const report = evaluate(inputPlan, result);
  assert.equal(report.outcome, "failed");
  assert.deepEqual(report.failedScenarios, ["warm-concurrency-four"]);
  assert.equal(report.scenarioResults.find((item) => item.scenarioKey === "warm-concurrency-four").errorRate, 0.2);
  assert.deepEqual(report.scenarioResults.find((item) => item.scenarioKey === "warm-concurrency-four").errors, [{ classification: "worker-timeout", retryable: true, count: 1 }]);
});

test("missing scenarios, metrics, raw evidence, and lineage drift fail closed", () => {
  const inputPlan = plan();
  const missingScenario = execution(inputPlan); missingScenario.scenarioResults.pop();
  assert.throws(() => evaluate(inputPlan, missingScenario), { code: "benchmark_result_incomplete" });
  const missingMetric = execution(inputPlan); delete missingMetric.scenarioResults[0].metrics.power_watts_peak;
  assert.throws(() => evaluate(inputPlan, missingMetric), { code: "benchmark_result_invalid" });
  const badEvidence = execution(inputPlan); badEvidence.scenarioResults[0].rawEvidence.reference = "https://storage.invalid/signed";
  assert.throws(() => evaluate(inputPlan, badEvidence), { code: "benchmark_result_invalid" });
  const drift = execution(inputPlan); drift.environmentDigest = digest("9");
  assert.throws(() => evaluate(inputPlan, drift), { code: "benchmark_result_mismatch" });
});

test("comparison emits deltas only for identical workload, environment, runner, and telemetry facts", () => {
  const leftPlan = plan();
  const rightPlan = plan({ profileFingerprint: digest("1"), deploymentFingerprint: digest("2") });
  const left = evaluate(leftPlan, execution(leftPlan));
  const right = evaluate(rightPlan, execution(rightPlan, {
    mutateMetric(value, metricKey) {
      return metricKey === "first_result_ms" && value.status === "measured" ? { ...value, value: value.value * 0.8 } : value;
    },
  }));
  const comparison = compareModelBenchmarkReports(left, right);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.leftProfileFingerprint, digest("a"));
  assert.equal(comparison.rightProfileFingerprint, digest("1"));
  assert.ok(comparison.deltas.some((delta) => delta.metricKey === "first_result_ms" && delta.relativeDelta < 0));

  const driftPlan = plan({ profileFingerprint: digest("3"), deploymentFingerprint: digest("4"), environmentDigest: digest("5") });
  const drift = compareModelBenchmarkReports(left, evaluate(driftPlan, execution(driftPlan)));
  assert.equal(drift.comparable, false);
  assert.ok(drift.reasons.includes("comparisonKey_mismatch"));
  assert.deepEqual(drift.deltas, []);
});

test("metric support mismatch blocks comparison instead of treating unsupported telemetry as zero", () => {
  const inputPlan = plan();
  const measured = evaluate(inputPlan, execution(inputPlan));
  const unsupported = evaluate(inputPlan, execution(inputPlan, {
    mutateMetric(value, metricKey) {
      return metricKey === "power_watts_peak" ? { status: "unsupported", reason: "driver-power-metric-unavailable" } : value;
    },
  }));
  const comparison = compareModelBenchmarkReports(measured, unsupported);
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.reasons[0].includes("metric_support_mismatch"));
  assert.deepEqual(comparison.deltas, []);
});

test("incomplete workload axes, mutable runners, invalid warmup, and non-finite telemetry are rejected", () => {
  const incomplete = plan(); incomplete.scenarios = incomplete.scenarios.filter((item) => !item.longContext);
  assert.throws(() => normalizeModelBenchmarkPlan(incomplete), { code: "benchmark_plan_invalid" });
  const mutable = plan(); mutable.runner.image = "docker.io/library/node:latest";
  assert.throws(() => normalizeModelBenchmarkPlan(mutable), { code: "benchmark_plan_invalid" });
  const warmup = plan(); warmup.scenarios[0].warmupRuns = 1;
  assert.throws(() => normalizeModelBenchmarkPlan(warmup), { code: "benchmark_plan_invalid" });
  const nonFinite = execution(plan(), {
    mutateMetric(value, metricKey) {
      return metricKey === "first_result_ms" ? { status: "measured", value: Number.NaN } : value;
    },
  });
  assert.throws(() => evaluate(plan(), nonFinite), { code: "benchmark_result_invalid" });
});
