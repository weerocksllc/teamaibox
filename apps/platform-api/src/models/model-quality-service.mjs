import { createHash } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const SLICE_KEY = /^[a-z][a-z0-9.-]{1,127}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const TASK_TYPES = new Set([
  "llm_reasoning_instruction",
  "ocr_text_layout",
  "asr_language_timestamp_speaker",
  "translation",
  "image_quality_prompt_adherence",
]);

export class ModelQualityError extends Error {
  constructor(code, message) { super(message); this.name = "ModelQualityError"; this.code = code; }
}

function fail(code, message) { throw new ModelQualityError(code, message); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("quality_suite_invalid", `${label} must be an object`);
  return value;
}
function exact(value, required, optional, label) {
  object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("quality_suite_invalid", `${label}.${key} is unsupported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("quality_suite_invalid", `${label}.${key} is required`);
  return value;
}
function text(value, label, { pattern = null, maximum = 512 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) {
    fail("quality_suite_invalid", `${label} is invalid`);
  }
  return value;
}
function integer(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("quality_suite_invalid", `${label} is invalid`);
  return value;
}
function number(value, label, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) fail("quality_suite_invalid", `${label} is invalid`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("quality_suite_invalid", "quality value cannot be canonicalized");
}
function sha(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }

export function normalizeModelQualitySuite(input) {
  exact(input, ["suiteKey", "version", "taskType", "corpus", "evaluator", "metrics", "acceptance"], [], "suite");
  exact(input.corpus, ["corpusKey", "version", "minimumCases", "requiredSlices"], [], "suite.corpus");
  if (!Array.isArray(input.corpus.requiredSlices) || input.corpus.requiredSlices.length < 1 || input.corpus.requiredSlices.length > 64) {
    fail("quality_suite_invalid", "suite.corpus.requiredSlices is invalid");
  }
  const requiredSlices = input.corpus.requiredSlices.map((slice, index) => {
    exact(slice, ["sliceKey", "minimumCases"], [], `suite.corpus.requiredSlices[${index}]`);
    return {
      sliceKey: text(slice.sliceKey, "slice.sliceKey", { pattern: SLICE_KEY, maximum: 128 }),
      minimumCases: integer(slice.minimumCases, "slice.minimumCases", 1, 10_000_000),
    };
  }).sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));
  if (new Set(requiredSlices.map((slice) => slice.sliceKey)).size !== requiredSlices.length) fail("quality_suite_invalid", "quality corpus slices must be unique");

  exact(input.evaluator, ["image", "implementationDigest", "deterministic", "seeds"], [], "suite.evaluator");
  if (input.evaluator.deterministic !== true || !Array.isArray(input.evaluator.seeds)
      || input.evaluator.seeds.length < 1 || input.evaluator.seeds.length > 32
      || input.evaluator.seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0)
      || new Set(input.evaluator.seeds).size !== input.evaluator.seeds.length) {
    fail("quality_suite_invalid", "quality evaluator must declare unique deterministic seeds");
  }

  if (!Array.isArray(input.metrics) || input.metrics.length < 1 || input.metrics.length > 64) fail("quality_suite_invalid", "suite.metrics is invalid");
  const metrics = input.metrics.map((metric, index) => {
    exact(metric, ["metricKey", "unit", "aggregation", "direction", "threshold", "maximumRegression", "minimumSamples", "requiredSlices"], [], `suite.metrics[${index}]`);
    if (!new Set(["minimum", "maximum"]).has(metric.direction)) fail("quality_suite_invalid", "metric.direction is invalid");
    if (!new Set(["mean", "micro", "macro", "median", "p95", "rate"]).has(metric.aggregation)) fail("quality_suite_invalid", "metric.aggregation is invalid");
    if (!Array.isArray(metric.requiredSlices) || metric.requiredSlices.length < 1
        || metric.requiredSlices.some((slice) => !requiredSlices.some((required) => required.sliceKey === slice))
        || new Set(metric.requiredSlices).size !== metric.requiredSlices.length) fail("quality_suite_invalid", "metric.requiredSlices is invalid");
    const minimumSamples = integer(metric.minimumSamples, "metric.minimumSamples", 1, 10_000_000);
    for (const sliceKey of metric.requiredSlices) {
      const slice = requiredSlices.find((candidate) => candidate.sliceKey === sliceKey);
      if (slice && minimumSamples > slice.minimumCases) fail("quality_suite_invalid", "metric minimum samples exceed its corpus slice");
    }
    return {
      metricKey: text(metric.metricKey, "metric.metricKey", { pattern: KEY, maximum: 128 }),
      unit: text(metric.unit, "metric.unit", { pattern: KEY, maximum: 64 }),
      aggregation: metric.aggregation,
      direction: metric.direction,
      threshold: number(metric.threshold, "metric.threshold"),
      maximumRegression: metric.maximumRegression === null ? null : number(metric.maximumRegression, "metric.maximumRegression"),
      minimumSamples,
      requiredSlices: [...metric.requiredSlices].sort(),
    };
  }).sort((left, right) => left.metricKey.localeCompare(right.metricKey));
  if (new Set(metrics.map((metric) => metric.metricKey)).size !== metrics.length) fail("quality_suite_invalid", "quality metrics must be unique");

  exact(input.acceptance, ["policy", "maximumFailedMeasurements", "missingMeasurement", "nonFiniteMeasurement"], [], "suite.acceptance");
  if (input.acceptance.policy !== "all-required-thresholds"
      || input.acceptance.maximumFailedMeasurements !== 0
      || input.acceptance.missingMeasurement !== "fail"
      || input.acceptance.nonFiniteMeasurement !== "fail") {
    fail("quality_suite_invalid", "quality acceptance policy must fail closed");
  }
  if (!TASK_TYPES.has(input.taskType)) fail("quality_suite_invalid", "suite.taskType is invalid");

  return Object.freeze({
    schemaVersion: 1,
    suiteKey: text(input.suiteKey, "suite.suiteKey", { pattern: KEY, maximum: 192 }),
    version: text(input.version, "suite.version", { pattern: SEMVER, maximum: 64 }),
    taskType: input.taskType,
    corpus: {
      corpusKey: text(input.corpus.corpusKey, "suite.corpus.corpusKey", { pattern: KEY, maximum: 192 }),
      version: text(input.corpus.version, "suite.corpus.version", { pattern: SEMVER, maximum: 64 }),
      minimumCases: integer(input.corpus.minimumCases, "suite.corpus.minimumCases", 1, 10_000_000),
      requiredSlices,
    },
    evaluator: {
      image: text(input.evaluator.image, "suite.evaluator.image", { pattern: IMAGE, maximum: 512 }),
      implementationDigest: text(input.evaluator.implementationDigest, "suite.evaluator.implementationDigest", { pattern: DIGEST, maximum: 71 }),
      deterministic: true,
      seeds: [...input.evaluator.seeds].sort((left, right) => left - right),
    },
    metrics,
    acceptance: structuredClone(input.acceptance),
  });
}

function resultText(value, label, pattern, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail("quality_result_invalid", `${label} is invalid`);
  return value;
}
function resultInteger(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("quality_result_invalid", `${label} is invalid`);
  return value;
}
function resultNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) fail("quality_result_invalid", `${label} is invalid`);
  return value;
}
function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("quality_result_invalid", `${label} is invalid`);
  return value;
}

export function evaluateModelQuality({ suite, expectedSuiteDigest, corpusDigest, profileFingerprint, baselineProfileFingerprint = null, result }) {
  const normalized = normalizeModelQualitySuite(suite);
  const suiteDigest = sha(normalized);
  if (expectedSuiteDigest !== suiteDigest) fail("quality_result_mismatch", "quality suite digest does not match the validation plan");
  resultText(corpusDigest, "corpusDigest", DIGEST, 71);
  resultText(profileFingerprint, "profileFingerprint", DIGEST, 71);
  if (baselineProfileFingerprint !== null) resultText(baselineProfileFingerprint, "baselineProfileFingerprint", DIGEST, 71);
  exact(result, ["suiteDigest", "corpusDigest", "profileFingerprint", "baselineProfileFingerprint", "evaluatorImage", "implementationDigest", "seed", "caseCount", "sliceCounts", "measurements", "startedAt", "finishedAt"], [], "result");
  if (result.suiteDigest !== suiteDigest || result.corpusDigest !== corpusDigest
      || result.profileFingerprint !== profileFingerprint
      || result.baselineProfileFingerprint !== baselineProfileFingerprint
      || result.evaluatorImage !== normalized.evaluator.image
      || result.implementationDigest !== normalized.evaluator.implementationDigest
      || !normalized.evaluator.seeds.includes(result.seed)) fail("quality_result_mismatch", "quality result does not match immutable suite, corpus, profile, evaluator, or seed facts");
  const caseCount = resultInteger(result.caseCount, "result.caseCount");
  if (caseCount < normalized.corpus.minimumCases) fail("quality_result_incomplete", "quality result has too few corpus cases");
  if (!Array.isArray(result.sliceCounts) || result.sliceCounts.length !== normalized.corpus.requiredSlices.length) fail("quality_result_incomplete", "quality slice coverage is incomplete");
  const requiredSliceCounts = new Map(normalized.corpus.requiredSlices.map((slice) => [slice.sliceKey, slice.minimumCases]));
  const sliceCounts = result.sliceCounts.map((slice, index) => {
    exact(slice, ["sliceKey", "caseCount"], [], `result.sliceCounts[${index}]`);
    const minimum = requiredSliceCounts.get(slice.sliceKey);
    if (minimum === undefined) fail("quality_result_invalid", "quality result contains an unexpected slice");
    const count = resultInteger(slice.caseCount, "slice.caseCount");
    if (count < minimum) fail("quality_result_incomplete", "quality slice has too few cases");
    requiredSliceCounts.delete(slice.sliceKey);
    return { sliceKey: slice.sliceKey, caseCount: count };
  }).sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));
  if (requiredSliceCounts.size) fail("quality_result_incomplete", "quality slice coverage is incomplete");
  const actualSliceCounts = new Map(sliceCounts.map((slice) => [slice.sliceKey, slice.caseCount]));

  const expectedMeasurements = new Map();
  for (const metric of normalized.metrics) {
    for (const sliceKey of metric.requiredSlices) expectedMeasurements.set(`${metric.metricKey}\0${sliceKey}`, metric);
  }
  if (!Array.isArray(result.measurements) || result.measurements.length !== expectedMeasurements.size) fail("quality_result_incomplete", "quality measurements are incomplete");
  const measurements = result.measurements.map((measurement, index) => {
    exact(measurement, ["metricKey", "sliceKey", "value", "baselineValue", "sampleCount"], [], `result.measurements[${index}]`);
    const key = `${measurement.metricKey}\0${measurement.sliceKey}`;
    const specification = expectedMeasurements.get(key);
    if (!specification) fail("quality_result_invalid", "quality result contains an unexpected or duplicate measurement");
    expectedMeasurements.delete(key);
    const value = resultNumber(measurement.value, "measurement.value");
    const sampleCount = resultInteger(measurement.sampleCount, "measurement.sampleCount");
    if (sampleCount < specification.minimumSamples) fail("quality_result_incomplete", "quality measurement has too few samples");
    if (sampleCount > actualSliceCounts.get(measurement.sliceKey)) fail("quality_result_invalid", "quality measurement samples exceed its corpus slice");
    const baselineValue = measurement.baselineValue === null ? null : resultNumber(measurement.baselineValue, "measurement.baselineValue");
    const requiresBaseline = baselineProfileFingerprint !== null && specification.maximumRegression !== null;
    if (requiresBaseline !== (baselineValue !== null)) fail("quality_result_incomplete", "quality regression baseline is missing or unexpected");
    const absolutePassed = specification.direction === "minimum"
      ? value >= specification.threshold
      : value <= specification.threshold;
    const regression = baselineValue === null ? null : specification.direction === "minimum"
      ? baselineValue - value
      : value - baselineValue;
    const regressionPassed = regression === null || regression <= specification.maximumRegression;
    return {
      metricKey: measurement.metricKey,
      sliceKey: measurement.sliceKey,
      value,
      baselineValue,
      sampleCount,
      threshold: specification.threshold,
      direction: specification.direction,
      maximumRegression: specification.maximumRegression,
      regression,
      passed: absolutePassed && regressionPassed,
    };
  }).sort((left, right) => `${left.metricKey}\0${left.sliceKey}`.localeCompare(`${right.metricKey}\0${right.sliceKey}`));
  if (expectedMeasurements.size) fail("quality_result_incomplete", "quality measurements are incomplete");
  const startedAt = timestamp(result.startedAt, "result.startedAt");
  const finishedAt = timestamp(result.finishedAt, "result.finishedAt");
  if (finishedAt <= startedAt) fail("quality_result_invalid", "quality result interval is invalid");
  const failures = measurements.filter((measurement) => !measurement.passed).map((measurement) => ({
    metricKey: measurement.metricKey,
    sliceKey: measurement.sliceKey,
    value: measurement.value,
    threshold: measurement.threshold,
    regression: measurement.regression,
    maximumRegression: measurement.maximumRegression,
  }));
  const report = {
    schemaVersion: 1,
    suiteKey: normalized.suiteKey,
    suiteVersion: normalized.version,
    suiteDigest,
    taskType: normalized.taskType,
    corpusDigest,
    profileFingerprint,
    baselineProfileFingerprint,
    evaluatorImage: normalized.evaluator.image,
    implementationDigest: normalized.evaluator.implementationDigest,
    seed: result.seed,
    caseCount,
    sliceCounts,
    measurements,
    failures,
    outcome: failures.length <= normalized.acceptance.maximumFailedMeasurements ? "passed" : "failed",
    startedAt,
    finishedAt,
  };
  return Object.freeze({ ...report, reportDigest: sha(report) });
}

export const modelQualitySuiteDigest = (suite) => sha(normalizeModelQualitySuite(suite));
export const modelQualityTaskTypes = Object.freeze([...TASK_TYPES].sort());
