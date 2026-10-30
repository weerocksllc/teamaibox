import assert from "node:assert/strict";
import test from "node:test";

import { ModelReportService, renderModelCardMarkdown } from "../src/models/model-report-service.mjs";

const profileId = "00000000-0000-4000-8000-000000007901";
const profileKey = "llm.qwen.nvfp4.spark.v1";
const viewer = { permissions: ["model:view"] };

function fixture({ state = "certified" } = {}) {
  const profile = {
    profileId, profileKey, source: { model: "nvidia/Qwen", revision: "revision-1" },
    engine: { name: "vllm", version: "0.10.0", imageDigest: `sha256:${"1".repeat(64)}` },
    precision: "nvfp4", artifactDigest: `sha256:${"2".repeat(64)}`,
    apiContracts: ["openai.responses@v1"], limits: { contextTokens: 32768 },
    resourceEnvelope: { unifiedMemoryBytes: 64_000_000_000 }, exclusive: false,
    compatibility: {
      architectures: ["linux/arm64/v8"],
      hardware: { acceleratorFamilies: ["nvidia-gb10-blackwell"], minimumComputeCapability: "12.1", minimumCpuCores: 16, minimumUnifiedMemoryBytes: 128_000_000_000 },
      software: { os: "linux", kernelRange: ">=6.17 <7", driverRange: ">=580 <590", cudaRange: ">=13 <14", containerToolkitRange: ">=1.17 <2" },
    },
    validationEvidence: [{ evidenceRef: "evidence://models/discovery" }],
    knownLimitations: ["Exact Spark environment only."],
  };
  const catalog = {
    async getProfile(key) { return key === profileKey ? { profile, fingerprint: `sha256:${"3".repeat(64)}` } : null; },
    async getLifecycle() { return { state, revision: 4, reasonKey: "model.lifecycle.validation_passed", validationRunId: "run-1", updatedAt: "2026-08-11T06:00:00.000Z", evidenceRefs: ["object://validation/final"] }; },
    async listValidationRuns() { return [{
      runId: "run-1", state: "certified", environmentDigest: `sha256:${"4".repeat(64)}`,
      stages: [{ stage: "quality", state: "passed", result: { outcome: "passed", startedAt: "2026-08-11T05:00:00.000Z", finishedAt: "2026-08-11T05:01:00.000Z", evidence: [{ reference: "object://validation/quality" }] } }],
    }]; },
    async listComparisons() { return [{
      comparisonKind: "nvfp4-versus-bf16-identical-workload", outcome: "passed",
      candidate: { profileKey }, reference: { profileKey: "llm.qwen.bf16.spark.v1" },
      comparability: { workloadDigest: `sha256:${"5".repeat(64)}`, environmentDigest: `sha256:${"6".repeat(64)}` },
      quality: { passed: true }, stability: { passed: true },
      performance: { peakHostUnifiedMemoryUsedBytes: { candidate: 60, reference: 100, percent: -40 }, scenarios: [] },
      rawEvidenceRefs: ["evidence://comparisons/nvfp4-bf16"], certificationClaimEligible: true,
    }]; },
  };
  return new ModelReportService({ catalog, clock: () => new Date("2026-08-11T06:30:00.000Z") });
}

test("generates an administrator-readable certified NVFP4 card from immutable evidence", async () => {
  const card = await fixture().generateCard({ context: viewer, profileKey });
  assert.equal(card.lifecycle.state, "certified");
  assert.equal(card.routingRecommendation.productionEligible, true);
  assert.equal(card.routingRecommendation.recommendationKey, "model.routing.prefer_certified_nvfp4");
  assert.ok(card.compatibilityMatrix.some((row) => row.requirement === "driverRange"));
  assert.deepEqual(card.rawRunLinks, [
    "evidence://comparisons/nvfp4-bf16", "evidence://models/discovery",
    "object://validation/final", "object://validation/quality",
  ]);
  const markdown = renderModelCardMarkdown(card, "zh-CN");
  assert.match(markdown, /环境兼容矩阵/);
  assert.match(markdown, /生产路由.*允许/);
});

test("a Validating card explains that production routing remains blocked", async () => {
  const card = await fixture({ state: "validating" }).generateCard({ context: viewer, profileKey });
  assert.equal(card.routingRecommendation.productionEligible, false);
  assert.equal(card.routingRecommendation.recommendationKey, "model.routing.validation_in_progress");
});

test("model cards require administrator viewing permission and complete lifecycle evidence", async () => {
  await assert.rejects(fixture().generateCard({ context: { permissions: [] }, profileKey }), (error) => error.code === "model_viewer_required");
  await assert.rejects(fixture().generateCard({ context: viewer, profileKey: "not valid" }), (error) => error.code === "model_report_input_invalid");
});
