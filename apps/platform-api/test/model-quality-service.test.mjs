import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  evaluateModelQuality,
  modelQualitySuiteDigest,
  modelQualityTaskTypes,
  normalizeModelQualitySuite,
} from "../src/models/model-quality-service.mjs";

const catalog = JSON.parse(await readFile(
  new URL("../../../models/quality-suite-catalog.v1.json", import.meta.url),
  "utf8",
));
const catalogSchema = JSON.parse(await readFile(
  new URL("../../../models/quality-suite-catalog.v1.schema.json", import.meta.url),
  "utf8",
));
const profileFingerprint = `sha256:${"a".repeat(64)}`;
const baselineProfileFingerprint = `sha256:${"b".repeat(64)}`;
const corpusDigest = `sha256:${"c".repeat(64)}`;

function execution(suite, { baseline = null, mutate = (value) => value } = {}) {
  const normalized = normalizeModelQualitySuite(suite);
  const measurements = normalized.metrics.flatMap((metric) => metric.requiredSlices.map((sliceKey) => {
    const margin = metric.threshold === 0 ? 0 : Math.min(metric.threshold / 10, 0.01);
    const value = metric.direction === "minimum" ? metric.threshold + margin : Math.max(0, metric.threshold - margin);
    let baselineValue = null;
    if (baseline && metric.maximumRegression !== null) {
      baselineValue = metric.direction === "minimum"
        ? value + metric.maximumRegression / 2
        : Math.max(0, value - metric.maximumRegression / 2);
    }
    return mutate({
      metricKey: metric.metricKey,
      sliceKey,
      value,
      baselineValue,
      sampleCount: metric.minimumSamples,
    }, metric);
  }));
  return {
    suiteDigest: modelQualitySuiteDigest(suite),
    corpusDigest,
    profileFingerprint,
    baselineProfileFingerprint: baseline,
    evaluatorImage: normalized.evaluator.image,
    implementationDigest: normalized.evaluator.implementationDigest,
    seed: normalized.evaluator.seeds[0],
    caseCount: normalized.corpus.minimumCases,
    sliceCounts: normalized.corpus.requiredSlices.map((slice) => ({
      sliceKey: slice.sliceKey,
      caseCount: slice.minimumCases,
    })),
    measurements,
    startedAt: "2026-08-11T00:00:00.000Z",
    finishedAt: "2026-08-11T00:10:00.000Z",
  };
}

function evaluate(suite, result, baseline = null) {
  return evaluateModelQuality({
    suite,
    expectedSuiteDigest: modelQualitySuiteDigest(suite),
    corpusDigest,
    profileFingerprint,
    baselineProfileFingerprint: baseline,
    result,
  });
}

test("catalog provides one immutable fail-closed suite for every required quality task", async () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.catalogVersion, "1.0.0");
  assert.equal(catalog.status, "initial-threshold-policy");
  assert.equal(catalog.suites.length, 5);
  assert.equal(catalogSchema.properties.suites.minItems, 5);
  assert.equal(catalogSchema.properties.suites.maxItems, 5);
  assert.deepEqual([...catalogSchema.$defs.suite.properties.taskType.enum].sort(), modelQualityTaskTypes);
  assert.deepEqual([...new Set(catalog.suites.map((suite) => suite.taskType))].sort(), modelQualityTaskTypes);
  assert.equal(new Set(catalog.suites.map((suite) => suite.suiteKey)).size, 5);
  const source = await readFile(new URL("../src/models/model-quality-service.mjs", import.meta.url));
  const implementationDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const translationSource = await readFile(new URL("../../../tools/translation_quality_evaluator.py", import.meta.url));
  const translationImplementationDigest = `sha256:${createHash("sha256").update(translationSource).digest("hex")}`;
  for (const suite of catalog.suites) {
    const normalized = normalizeModelQualitySuite(suite);
    assert.equal(normalized.schemaVersion, 1);
    assert.match(modelQualitySuiteDigest(suite), /^sha256:[a-f0-9]{64}$/);
    assert.equal(normalized.evaluator.implementationDigest,
      suite.taskType === "translation" ? translationImplementationDigest : implementationDigest,
      suite.suiteKey);
    if (suite.taskType === "translation") {
      assert.match(normalized.evaluator.image,
        /^127\.0\.0\.1:15000\/teamaibox\/model-quality\/translation-evaluator@sha256:[a-f0-9]{64}$/);
    }
    assert.equal(normalized.acceptance.maximumFailedMeasurements, 0);
    assert.equal(normalized.acceptance.missingMeasurement, "fail");
    assert.equal(normalized.acceptance.nonFiniteMeasurement, "fail");
  }
});

for (const suite of catalog.suites) {
  test(`quality thresholds pass complete deterministic evidence: ${suite.taskType}`, () => {
    const report = evaluate(suite, execution(suite));
    assert.equal(report.outcome, "passed");
    assert.equal(report.failures.length, 0);
    assert.equal(report.suiteKey, suite.suiteKey);
    assert.equal(report.suiteVersion, suite.version);
    assert.equal(report.baselineProfileFingerprint, null);
    assert.match(report.reportDigest, /^sha256:[a-f0-9]{64}$/);
  });
}

test("an absolute threshold miss returns immutable failed evidence instead of being averaged away", () => {
  const suite = catalog.suites.find((candidate) => candidate.taskType === "ocr_text_layout");
  const result = execution(suite, {
    mutate(measurement, metric) {
      return metric.metricKey === "layout-block-f1"
        ? { ...measurement, value: metric.threshold - 0.001 }
        : measurement;
    },
  });
  const report = evaluate(suite, result);
  assert.equal(report.outcome, "failed");
  assert.deepEqual(report.failures.map((failure) => failure.metricKey), ["layout-block-f1"]);
  assert.equal(report.failures[0].value < report.failures[0].threshold, true);
});

test("baseline comparison blocks a regression even when the absolute floor still passes", () => {
  const suite = catalog.suites.find((candidate) => candidate.taskType === "llm_reasoning_instruction");
  const result = execution(suite, {
    baseline: baselineProfileFingerprint,
    mutate(measurement, metric) {
      if (metric.metricKey !== "instruction-following-pass-rate") return measurement;
      return {
        ...measurement,
        value: metric.threshold + 0.01,
        baselineValue: metric.threshold + 0.01 + metric.maximumRegression + 0.001,
      };
    },
  });
  const report = evaluate(suite, result, baselineProfileFingerprint);
  assert.equal(report.outcome, "failed");
  assert.deepEqual(report.failures.map((failure) => failure.metricKey), ["instruction-following-pass-rate"]);
  assert.equal(report.failures[0].value >= report.failures[0].threshold, true);
  assert.equal(report.failures[0].regression > report.failures[0].maximumRegression, true);
});

test("missing slices, measurements, baselines, and non-finite values fail closed", () => {
  const suite = catalog.suites[0];
  const missingSlice = execution(suite);
  missingSlice.sliceCounts.pop();
  assert.throws(() => evaluate(suite, missingSlice), { code: "quality_result_incomplete" });

  const missingMeasurement = execution(suite);
  missingMeasurement.measurements.pop();
  assert.throws(() => evaluate(suite, missingMeasurement), { code: "quality_result_incomplete" });

  const missingBaseline = execution(suite, { baseline: baselineProfileFingerprint });
  missingBaseline.measurements[0].baselineValue = null;
  assert.throws(() => evaluate(suite, missingBaseline, baselineProfileFingerprint), { code: "quality_result_incomplete" });

  const nonFinite = execution(suite);
  nonFinite.measurements[0].value = Number.NaN;
  assert.throws(() => evaluate(suite, nonFinite), { code: "quality_result_invalid" });
});

test("suite, corpus, profile, evaluator, seed, and interval drift are rejected", () => {
  const suite = catalog.suites[0];
  const wrongSuite = execution(suite);
  wrongSuite.suiteDigest = `sha256:${"d".repeat(64)}`;
  assert.throws(() => evaluate(suite, wrongSuite), { code: "quality_result_mismatch" });
  const wrongCorpus = execution(suite);
  wrongCorpus.corpusDigest = `sha256:${"e".repeat(64)}`;
  assert.throws(() => evaluate(suite, wrongCorpus), { code: "quality_result_mismatch" });
  const wrongEvaluator = execution(suite);
  wrongEvaluator.evaluatorImage = wrongEvaluator.evaluatorImage.replace(/.$/, (value) => value === "0" ? "1" : "0");
  assert.throws(() => evaluate(suite, wrongEvaluator), { code: "quality_result_mismatch" });
  const wrongSeed = execution(suite);
  wrongSeed.seed = 999;
  assert.throws(() => evaluate(suite, wrongSeed), { code: "quality_result_mismatch" });
  const wrongInterval = execution(suite);
  wrongInterval.finishedAt = wrongInterval.startedAt;
  assert.throws(() => evaluate(suite, wrongInterval), { code: "quality_result_invalid" });
});


test("any threshold policy change creates a new suite digest and duplicate declarations are invalid", () => {
  const suite = catalog.suites[0];
  const changed = structuredClone(suite);
  changed.metrics[0].threshold += 0.001;
  assert.notEqual(modelQualitySuiteDigest(changed), modelQualitySuiteDigest(suite));
  const duplicated = structuredClone(suite);
  duplicated.metrics.push(structuredClone(duplicated.metrics[0]));
  assert.throws(() => normalizeModelQualitySuite(duplicated), { code: "quality_suite_invalid" });
  const unknown = { ...structuredClone(suite), silentOverride: true };
  assert.throws(() => normalizeModelQualitySuite(unknown), { code: "quality_suite_invalid" });
});
