import { createHash } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const RESULT_KINDS = new Set(["token_stream", "image", "document", "audio"]);
const TARGET_KINDS = new Set(["local", "managed_node", "external_provider"]);
const CODEC_MODES = new Set(["none", "encode", "decode", "transcode"]);

export const MODEL_BENCHMARK_METRICS = Object.freeze({
  load_time_ms: { kind: "number", aggregation: "median" },
  first_result_ms: { kind: "number", aggregation: "median" },
  ttft_ms: { kind: "number", aggregation: "median" },
  result_throughput_per_second: { kind: "number", aggregation: "mean" },
  token_throughput_per_second: { kind: "number", aggregation: "mean" },
  peak_unified_memory_bytes: { kind: "integer", aggregation: "maximum" },
  cpu_percent_mean: { kind: "percent", aggregation: "mean" },
  disk_read_bytes: { kind: "integer", aggregation: "sum" },
  disk_write_bytes: { kind: "integer", aggregation: "sum" },
  network_receive_bytes: { kind: "integer", aggregation: "sum" },
  network_transmit_bytes: { kind: "integer", aggregation: "sum" },
  accelerator_utilization_percent_mean: { kind: "percent", aggregation: "mean" },
  codec_encode_sessions_peak: { kind: "integer", aggregation: "maximum" },
  codec_decode_sessions_peak: { kind: "integer", aggregation: "maximum" },
  temperature_celsius_peak: { kind: "number", aggregation: "maximum" },
  power_watts_peak: { kind: "number", aggregation: "maximum" },
});

export class ModelBenchmarkError extends Error {
  constructor(code, message) { super(message); this.name = "ModelBenchmarkError"; this.code = code; }
}

function fail(code, message) { throw new ModelBenchmarkError(code, message); }
function object(value, label, code = "benchmark_plan_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  return value;
}
function exact(value, required, optional, label, code = "benchmark_plan_invalid") {
  object(value, label, code); const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(code, `${label}.${key} is required`);
  return value;
}
function text(value, label, pattern = KEY, maximum = 512, code = "benchmark_plan_invalid") {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(code, `${label} is invalid`);
  return value;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, code = "benchmark_plan_invalid") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code, `${label} is invalid`);
  return value;
}
function number(value, label, minimum = 0, maximum = Number.MAX_VALUE, code = "benchmark_plan_invalid") {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(code, `${label} is invalid`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("benchmark_plan_invalid", "benchmark value cannot be canonicalized");
}
function sha(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("benchmark_result_invalid", `${label} is invalid`);
  return value;
}

export function normalizeModelBenchmarkPlan(input) {
  exact(input, ["benchmarkKey", "version", "profileFingerprint", "deploymentFingerprint", "environmentDigest", "inputSetDigest", "runner", "telemetry", "scenarios", "acceptance"], ["schemaVersion"], "plan");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail("benchmark_plan_invalid", "benchmark plan schema version is invalid");
  exact(input.runner, ["image", "implementationDigest"], [], "plan.runner");
  exact(input.telemetry, ["schemaVersion", "sampleIntervalMilliseconds", "warmupExcluded", "clock"], [], "plan.telemetry");
  if (input.telemetry.schemaVersion !== 1 || input.telemetry.warmupExcluded !== true || input.telemetry.clock !== "monotonic") fail("benchmark_plan_invalid", "benchmark telemetry contract is invalid");
  exact(input.acceptance, ["maximumErrorRate", "minimumCompletedRequests"], [], "plan.acceptance");
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 5 || input.scenarios.length > 128) fail("benchmark_plan_invalid", "benchmark scenario matrix is incomplete");
  const scenarios = input.scenarios.map((scenario, index) => {
    exact(scenario, ["scenarioKey", "inputClass", "resultKind", "targetKind", "codecMode", "coldStart", "batchSize", "concurrency", "contextTokens", "outputTokens", "longContext", "warmupRuns", "measuredRuns", "timeoutSeconds"], [], `plan.scenarios[${index}]`);
    if (!RESULT_KINDS.has(scenario.resultKind) || !TARGET_KINDS.has(scenario.targetKind) || !CODEC_MODES.has(scenario.codecMode)) fail("benchmark_plan_invalid", "benchmark scenario mode is invalid");
    if (typeof scenario.coldStart !== "boolean" || typeof scenario.longContext !== "boolean") fail("benchmark_plan_invalid", "benchmark scenario flags are invalid");
    const warmupRuns = integer(scenario.warmupRuns, "scenario.warmupRuns", 0, 1000);
    if ((scenario.coldStart && warmupRuns !== 0) || (!scenario.coldStart && warmupRuns < 1)) fail("benchmark_plan_invalid", "cold and warm scenarios have invalid warmup policy");
    const contextTokens = integer(scenario.contextTokens, "scenario.contextTokens", 0, 10_000_000);
    const outputTokens = integer(scenario.outputTokens, "scenario.outputTokens", 0, 10_000_000);
    if (scenario.resultKind === "token_stream" ? contextTokens < 1 || outputTokens < 1 : contextTokens !== 0 || outputTokens !== 0) fail("benchmark_plan_invalid", "token dimensions do not match result kind");
    if (scenario.longContext && (scenario.resultKind !== "token_stream" || contextTokens < 8192)) fail("benchmark_plan_invalid", "long-context scenario is invalid");
    return {
      scenarioKey: text(scenario.scenarioKey, "scenario.scenarioKey"),
      inputClass: text(scenario.inputClass, "scenario.inputClass"),
      resultKind: scenario.resultKind,
      targetKind: scenario.targetKind,
      codecMode: scenario.codecMode,
      coldStart: scenario.coldStart,
      batchSize: integer(scenario.batchSize, "scenario.batchSize", 1, 4096),
      concurrency: integer(scenario.concurrency, "scenario.concurrency", 1, 4096),
      contextTokens, outputTokens, longContext: scenario.longContext, warmupRuns,
      measuredRuns: integer(scenario.measuredRuns, "scenario.measuredRuns", 3, 100_000),
      timeoutSeconds: integer(scenario.timeoutSeconds, "scenario.timeoutSeconds", 1, 7 * 24 * 3600),
    };
  }).sort((left, right) => left.scenarioKey.localeCompare(right.scenarioKey));
  if (new Set(scenarios.map((scenario) => scenario.scenarioKey)).size !== scenarios.length) fail("benchmark_plan_invalid", "benchmark scenario keys must be unique");
  if (!scenarios.some((scenario) => scenario.coldStart)
    || !scenarios.some((scenario) => !scenario.coldStart)
    || !scenarios.some((scenario) => scenario.batchSize > 1)
    || !scenarios.some((scenario) => scenario.concurrency > 1)
    || !scenarios.some((scenario) => scenario.longContext)) fail("benchmark_plan_invalid", "benchmark must cover cold, warm, batch, concurrency, and long context");
  return Object.freeze({
    schemaVersion: 1,
    benchmarkKey: text(input.benchmarkKey, "plan.benchmarkKey"),
    version: text(input.version, "plan.version", SEMVER, 64),
    profileFingerprint: text(input.profileFingerprint, "plan.profileFingerprint", DIGEST, 71),
    deploymentFingerprint: text(input.deploymentFingerprint, "plan.deploymentFingerprint", DIGEST, 71),
    environmentDigest: text(input.environmentDigest, "plan.environmentDigest", DIGEST, 71),
    inputSetDigest: text(input.inputSetDigest, "plan.inputSetDigest", DIGEST, 71),
    runner: {
      image: text(input.runner.image, "plan.runner.image", IMAGE),
      implementationDigest: text(input.runner.implementationDigest, "plan.runner.implementationDigest", DIGEST, 71),
    },
    telemetry: {
      schemaVersion: 1,
      sampleIntervalMilliseconds: integer(input.telemetry.sampleIntervalMilliseconds, "plan.telemetry.sampleIntervalMilliseconds", 50, 60_000),
      warmupExcluded: true,
      clock: "monotonic",
    },
    scenarios,
    acceptance: {
      maximumErrorRate: number(input.acceptance.maximumErrorRate, "plan.acceptance.maximumErrorRate", 0, 1),
      minimumCompletedRequests: integer(input.acceptance.minimumCompletedRequests, "plan.acceptance.minimumCompletedRequests", 1, 10_000_000),
    },
  });
}

function comparisonFacts(plan) {
  return {
    benchmarkKey: plan.benchmarkKey,
    version: plan.version,
    environmentDigest: plan.environmentDigest,
    inputSetDigest: plan.inputSetDigest,
    runner: plan.runner,
    telemetry: plan.telemetry,
    scenarios: plan.scenarios,
  };
}

function expectedMetricStatus(metricKey, scenario) {
  if (metricKey === "load_time_ms") return scenario.coldStart ? (scenario.targetKind === "external_provider" ? "unsupported" : "measured") : "not_applicable";
  if (["ttft_ms", "token_throughput_per_second"].includes(metricKey)) return scenario.resultKind === "token_stream" ? "measured" : "not_applicable";
  if (["codec_encode_sessions_peak", "codec_decode_sessions_peak"].includes(metricKey)) {
    const direction = metricKey.includes("encode") ? "encode" : "decode";
    return scenario.codecMode === direction || scenario.codecMode === "transcode" ? "measured" : "not_applicable";
  }
  if (["peak_unified_memory_bytes", "cpu_percent_mean", "disk_read_bytes", "disk_write_bytes", "accelerator_utilization_percent_mean"].includes(metricKey)) {
    return scenario.targetKind === "external_provider" ? "unsupported" : "measured";
  }
  if (["temperature_celsius_peak", "power_watts_peak"].includes(metricKey)) {
    return scenario.targetKind === "external_provider" ? "unsupported" : "measured_or_unsupported";
  }
  return "measured";
}

function normalizeMeasurement(input, metricKey, scenario) {
  object(input, `measurement.${metricKey}`, "benchmark_result_invalid");
  const expected = expectedMetricStatus(metricKey, scenario);
  if (input.status === "measured") {
    exact(input, ["status", "value"], [], `measurement.${metricKey}`, "benchmark_result_invalid");
    if (expected === "not_applicable" || expected === "unsupported") fail("benchmark_result_invalid", `${metricKey} must not claim fabricated telemetry`);
    const specification = MODEL_BENCHMARK_METRICS[metricKey];
    const value = specification.kind === "integer"
      ? integer(input.value, metricKey, 0, Number.MAX_SAFE_INTEGER, "benchmark_result_invalid")
      : number(input.value, metricKey, 0, specification.kind === "percent" ? 100 : Number.MAX_VALUE, "benchmark_result_invalid");
    return { status: "measured", value };
  }
  if (input.status === "not_applicable") {
    exact(input, ["status", "reason"], [], `measurement.${metricKey}`, "benchmark_result_invalid");
    if (expected !== "not_applicable" || input.reason !== "metric_not_applicable") fail("benchmark_result_invalid", `${metricKey} applicability is invalid`);
    return { status: input.status, reason: input.reason };
  }
  if (input.status === "unsupported") {
    exact(input, ["status", "reason"], [], `measurement.${metricKey}`, "benchmark_result_invalid");
    if (!new Set(["unsupported", "measured_or_unsupported"]).has(expected)
      || typeof input.reason !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(input.reason)) fail("benchmark_result_invalid", `${metricKey} unsupported status is invalid`);
    return { status: input.status, reason: input.reason };
  }
  fail("benchmark_result_invalid", `${metricKey} measurement status is invalid`);
}

function aggregate(values, aggregation) {
  if (aggregation === "sum") return values.reduce((total, value) => total + value, 0);
  if (aggregation === "maximum") return Math.max(...values);
  if (aggregation === "mean") return values.reduce((total, value) => total + value, 0) / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export class ModelBenchmarkHarness {
  #plan; #planDigest; #records;

  constructor(plan) {
    this.#plan = normalizeModelBenchmarkPlan(plan);
    this.#planDigest = sha(this.#plan);
    this.#records = new Map(this.#plan.scenarios.map((scenario) => [scenario.scenarioKey, {
      scenario,
      warmups: 0,
      measured: [],
    }]));
  }

  recordWarmup({ scenarioKey }) {
    const state = this.#records.get(scenarioKey);
    if (!state || state.warmups >= state.scenario.warmupRuns) fail("benchmark_harness_sequence", "benchmark warmup is unexpected or exceeds its plan");
    state.warmups += 1;
  }

  recordMeasured({ scenarioKey, outcome, metrics = null, error = null }) {
    const state = this.#records.get(scenarioKey);
    if (!state || state.warmups !== state.scenario.warmupRuns || state.measured.length >= state.scenario.measuredRuns) fail("benchmark_harness_sequence", "benchmark measured run is out of sequence or exceeds its plan");
    if (outcome === "completed") {
      if (error !== null) fail("benchmark_result_invalid", "completed benchmark sample cannot carry an error");
      exact(metrics, Object.keys(MODEL_BENCHMARK_METRICS), [], "sample.metrics", "benchmark_result_invalid");
      state.measured.push({
        outcome,
        metrics: Object.fromEntries(Object.keys(MODEL_BENCHMARK_METRICS).map((metricKey) => [
          metricKey,
          normalizeMeasurement(metrics[metricKey], metricKey, state.scenario),
        ])),
      });
      return;
    }
    if (outcome !== "error" || metrics !== null) fail("benchmark_result_invalid", "benchmark sample outcome is invalid");
    exact(error, ["classification", "retryable"], [], "sample.error", "benchmark_result_invalid");
    if (typeof error.retryable !== "boolean") fail("benchmark_result_invalid", "benchmark error retryability is invalid");
    state.measured.push({
      outcome,
      error: {
        classification: text(error.classification, "sample.error.classification", KEY, 128, "benchmark_result_invalid"),
        retryable: error.retryable,
      },
    });
  }

  finalize({ rawEvidence, startedAt, finishedAt }) {
    if (!Array.isArray(rawEvidence) || rawEvidence.length !== this.#records.size) fail("benchmark_result_incomplete", "benchmark raw evidence set is incomplete");
    const evidenceByScenario = new Map();
    for (const item of rawEvidence) {
      if (!item || typeof item.scenarioKey !== "string" || evidenceByScenario.has(item.scenarioKey)) fail("benchmark_result_invalid", "benchmark raw evidence contains an invalid or duplicate scenario");
      evidenceByScenario.set(item.scenarioKey, item);
    }
    const scenarioResults = [];
    for (const state of this.#records.values()) {
      if (state.warmups !== state.scenario.warmupRuns || state.measured.length !== state.scenario.measuredRuns) fail("benchmark_result_incomplete", "benchmark harness has unfinished planned runs");
      const completed = state.measured.filter((sample) => sample.outcome === "completed");
      const metrics = {};
      for (const [metricKey, specification] of Object.entries(MODEL_BENCHMARK_METRICS)) {
        const measurements = completed.map((sample) => sample.metrics[metricKey]);
        if (!measurements.length) {
          metrics[metricKey] = expectedMetricStatus(metricKey, state.scenario) === "not_applicable"
            ? { status: "not_applicable", reason: "metric_not_applicable" }
            : { status: "unsupported", reason: "all-measured-runs-failed" };
          continue;
        }
        const status = measurements[0].status;
        if (measurements.some((measurement) => measurement.status !== status
          || (status !== "measured" && measurement.reason !== measurements[0].reason))) fail("benchmark_result_invalid", "benchmark sample metric support changed within one scenario");
        metrics[metricKey] = status === "measured"
          ? { status, value: aggregate(measurements.map((measurement) => measurement.value), specification.aggregation) }
          : structuredClone(measurements[0]);
      }
      const evidence = evidenceByScenario.get(state.scenario.scenarioKey);
      if (!evidence) fail("benchmark_result_incomplete", "benchmark scenario raw evidence is missing");
      const { scenarioKey: _scenarioKey, ...raw } = evidence;
      scenarioResults.push({
        scenarioKey: state.scenario.scenarioKey,
        completedRequests: completed.length,
        errorCount: state.measured.length - completed.length,
        errors: [...state.measured.filter((sample) => sample.outcome === "error").reduce((groups, sample) => {
          const key = `${sample.error.classification}\0${sample.error.retryable}`;
          const current = groups.get(key) ?? { ...sample.error, count: 0 };
          current.count += 1; groups.set(key, current); return groups;
        }, new Map()).values()].sort((left, right) => left.classification.localeCompare(right.classification)),
        metrics,
        rawEvidence: raw,
      });
    }
    return evaluateModelBenchmark({
      plan: this.#plan,
      expectedPlanDigest: this.#planDigest,
      result: {
        planDigest: this.#planDigest,
        profileFingerprint: this.#plan.profileFingerprint,
        deploymentFingerprint: this.#plan.deploymentFingerprint,
        environmentDigest: this.#plan.environmentDigest,
        inputSetDigest: this.#plan.inputSetDigest,
        runner: this.#plan.runner,
        scenarioResults,
        startedAt,
        finishedAt,
      },
    });
  }
}

export function evaluateModelBenchmark({ plan, expectedPlanDigest, result }) {
  const normalized = normalizeModelBenchmarkPlan(plan);
  const planDigest = sha(normalized);
  if (expectedPlanDigest !== planDigest) fail("benchmark_result_mismatch", "benchmark plan digest does not match the validation plan");
  exact(result, ["planDigest", "profileFingerprint", "deploymentFingerprint", "environmentDigest", "inputSetDigest", "runner", "scenarioResults", "startedAt", "finishedAt"], [], "result", "benchmark_result_invalid");
  exact(result.runner, ["image", "implementationDigest"], [], "result.runner", "benchmark_result_invalid");
  if (result.planDigest !== planDigest || result.profileFingerprint !== normalized.profileFingerprint
    || result.deploymentFingerprint !== normalized.deploymentFingerprint
    || result.environmentDigest !== normalized.environmentDigest || result.inputSetDigest !== normalized.inputSetDigest
    || result.runner.image !== normalized.runner.image || result.runner.implementationDigest !== normalized.runner.implementationDigest) fail("benchmark_result_mismatch", "benchmark result lineage does not match its immutable plan");
  if (!Array.isArray(result.scenarioResults) || result.scenarioResults.length !== normalized.scenarios.length) fail("benchmark_result_incomplete", "benchmark scenario results are incomplete");
  const pending = new Map(normalized.scenarios.map((scenario) => [scenario.scenarioKey, scenario]));
  const scenarioResults = result.scenarioResults.map((item, index) => {
    exact(item, ["scenarioKey", "completedRequests", "errorCount", "errors", "metrics", "rawEvidence"], [], `result.scenarioResults[${index}]`, "benchmark_result_invalid");
    const scenario = pending.get(item.scenarioKey);
    if (!scenario) fail("benchmark_result_invalid", "benchmark result contains an unexpected or duplicate scenario");
    pending.delete(item.scenarioKey);
    const completedRequests = integer(item.completedRequests, "scenario.completedRequests", 0, Number.MAX_SAFE_INTEGER, "benchmark_result_invalid");
    const errorCount = integer(item.errorCount, "scenario.errorCount", 0, Number.MAX_SAFE_INTEGER, "benchmark_result_invalid");
    if (!Array.isArray(item.errors)) fail("benchmark_result_invalid", "benchmark errors must be an array");
    const errorKeys = new Set();
    const errors = item.errors.map((error, errorIndex) => {
      exact(error, ["classification", "retryable", "count"], [], `scenario.errors[${errorIndex}]`, "benchmark_result_invalid");
      if (typeof error.retryable !== "boolean") fail("benchmark_result_invalid", "benchmark error retryability is invalid");
      const normalizedError = {
        classification: text(error.classification, "error.classification", KEY, 128, "benchmark_result_invalid"),
        retryable: error.retryable,
        count: integer(error.count, "error.count", 1, Number.MAX_SAFE_INTEGER, "benchmark_result_invalid"),
      };
      const key = `${normalizedError.classification}\0${normalizedError.retryable}`;
      if (errorKeys.has(key)) fail("benchmark_result_invalid", "benchmark error classification is duplicated");
      errorKeys.add(key); return normalizedError;
    }).sort((left, right) => left.classification.localeCompare(right.classification));
    if (errors.reduce((total, error) => total + error.count, 0) !== errorCount) fail("benchmark_result_invalid", "benchmark error counts are inconsistent");
    if (completedRequests + errorCount < scenario.measuredRuns || completedRequests < normalized.acceptance.minimumCompletedRequests) fail("benchmark_result_incomplete", "benchmark scenario has insufficient completed work");
    exact(item.metrics, Object.keys(MODEL_BENCHMARK_METRICS), [], "scenario.metrics", "benchmark_result_invalid");
    const metrics = Object.fromEntries(Object.keys(MODEL_BENCHMARK_METRICS).sort().map((metricKey) => [
      metricKey,
      normalizeMeasurement(item.metrics[metricKey], metricKey, scenario),
    ]));
    exact(item.rawEvidence, ["digest", "sizeBytes", "mediaType", "reference"], [], "scenario.rawEvidence", "benchmark_result_invalid");
    const rawEvidence = {
      digest: text(item.rawEvidence.digest, "rawEvidence.digest", DIGEST, 71, "benchmark_result_invalid"),
      sizeBytes: integer(item.rawEvidence.sizeBytes, "rawEvidence.sizeBytes", 1, Number.MAX_SAFE_INTEGER, "benchmark_result_invalid"),
      mediaType: text(item.rawEvidence.mediaType, "rawEvidence.mediaType", /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/, 256, "benchmark_result_invalid"),
      reference: text(item.rawEvidence.reference, "rawEvidence.reference", /^object:\/\/[A-Za-z0-9/._:-]+$/, 2048, "benchmark_result_invalid"),
    };
    const attemptedRequests = completedRequests + errorCount;
    const errorRate = attemptedRequests === 0 ? 1 : errorCount / attemptedRequests;
    return { scenarioKey: item.scenarioKey, completedRequests, errorCount, errorRate, errors, metrics, rawEvidence };
  }).sort((left, right) => left.scenarioKey.localeCompare(right.scenarioKey));
  if (pending.size) fail("benchmark_result_incomplete", "benchmark scenario results are incomplete");
  const startedAt = timestamp(result.startedAt, "result.startedAt"); const finishedAt = timestamp(result.finishedAt, "result.finishedAt");
  if (finishedAt <= startedAt) fail("benchmark_result_invalid", "benchmark result interval is invalid");
  const failedScenarios = scenarioResults.filter((scenario) => scenario.errorRate > normalized.acceptance.maximumErrorRate).map((scenario) => scenario.scenarioKey);
  const facts = comparisonFacts(normalized);
  const report = {
    schemaVersion: 1,
    benchmarkKey: normalized.benchmarkKey,
    version: normalized.version,
    planDigest,
    comparisonKey: sha(facts),
    comparisonFacts: facts,
    profileFingerprint: normalized.profileFingerprint,
    deploymentFingerprint: normalized.deploymentFingerprint,
    scenarioResults,
    failedScenarios,
    outcome: failedScenarios.length ? "failed" : "completed",
    startedAt,
    finishedAt,
  };
  return Object.freeze({ ...report, reportDigest: sha(report) });
}

export function compareModelBenchmarkReports(left, right) {
  object(left, "left", "benchmark_comparison_invalid"); object(right, "right", "benchmark_comparison_invalid");
  const reasons = [];
  for (const key of ["benchmarkKey", "version", "comparisonKey"]) if (left[key] !== right[key]) reasons.push(`${key}_mismatch`);
  if (left.outcome !== "completed" || right.outcome !== "completed") reasons.push("incomplete_or_failed_report");
  if (reasons.length) return Object.freeze({ comparable: false, reasons: Object.freeze([...new Set(reasons)].sort()), deltas: Object.freeze([]) });
  const rightScenarios = new Map(right.scenarioResults.map((scenario) => [scenario.scenarioKey, scenario]));
  if (left.scenarioResults.length !== rightScenarios.size || left.scenarioResults.some((scenario) => !rightScenarios.has(scenario.scenarioKey))) {
    return Object.freeze({ comparable: false, reasons: Object.freeze(["scenario_set_mismatch"]), deltas: Object.freeze([]) });
  }
  const deltas = [];
  for (const leftScenario of left.scenarioResults) {
    const rightScenario = rightScenarios.get(leftScenario.scenarioKey);
    deltas.push({ scenarioKey: leftScenario.scenarioKey, metricKey: "error_rate", left: leftScenario.errorRate, right: rightScenario.errorRate, absoluteDelta: rightScenario.errorRate - leftScenario.errorRate, relativeDelta: leftScenario.errorRate === 0 ? null : (rightScenario.errorRate - leftScenario.errorRate) / leftScenario.errorRate });
    for (const metricKey of Object.keys(MODEL_BENCHMARK_METRICS).sort()) {
      const leftMetric = leftScenario.metrics[metricKey]; const rightMetric = rightScenario.metrics[metricKey];
      if (leftMetric.status !== rightMetric.status) {
        return Object.freeze({ comparable: false, reasons: Object.freeze([`metric_support_mismatch:${leftScenario.scenarioKey}:${metricKey}`]), deltas: Object.freeze([]) });
      }
      if (leftMetric.status !== "measured") continue;
      deltas.push({ scenarioKey: leftScenario.scenarioKey, metricKey, left: leftMetric.value, right: rightMetric.value, absoluteDelta: rightMetric.value - leftMetric.value, relativeDelta: leftMetric.value === 0 ? null : (rightMetric.value - leftMetric.value) / leftMetric.value });
    }
  }
  return Object.freeze({
    comparable: true,
    reasons: Object.freeze([]),
    leftReportDigest: left.reportDigest,
    rightReportDigest: right.reportDigest,
    leftProfileFingerprint: left.profileFingerprint,
    rightProfileFingerprint: right.profileFingerprint,
    deltas: Object.freeze(deltas.map((delta) => Object.freeze(delta))),
  });
}

export const modelBenchmarkPlanDigest = (plan) => sha(normalizeModelBenchmarkPlan(plan));
