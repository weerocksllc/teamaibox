import assert from "node:assert/strict";
import test from "node:test";

import { MemoryModelValidationRepository } from "../src/models/memory-model-validation-repository.mjs";
import {
  MODEL_VALIDATION_STAGES,
  ModelValidationService,
} from "../src/models/model-validation-service.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const admin = { identityId: "00000000-0000-4000-8000-000000007701", permissions: ["model:manage"] };
const worker = { workerId: "worker.spark.validation-1", permissions: ["model:validate"] };
const profileFingerprint = digest("a");
const buildFingerprint = digest("b");
const deploymentFingerprint = digest("c");
const buildId = "00000000-0000-4000-8000-000000007702";
const deploymentId = "00000000-0000-4000-8000-000000007703";
const executorImage = `registry.example.test/model-validation@${digest("d")}`;

function plan(overrides = {}) {
  return {
    runKey: "qwen.nvfp4.validation.r1",
    profile: { profileKey: "qwen.nvfp4.profile.r1", fingerprint: profileFingerprint },
    build: { jobId: buildId, fingerprint: buildFingerprint },
    deployment: { jobId: deploymentId, fingerprint: deploymentFingerprint },
    corpusDigest: digest("e"), policyDigest: digest("f"),
    stages: MODEL_VALIDATION_STAGES.map((stage, ordinal) => ({
      stage, executorImage, suiteDigest: digest(String(ordinal % 10)),
      configurationDigest: digest(String((ordinal + 1) % 10)),
      timeoutSeconds: stage === "stress_soak" ? 8 * 3600 : 3600,
      exclusive: new Set(["build", "benchmark", "stress_soak", "coexistence_cluster"]).has(stage),
      evidenceKinds: [`${stage}.report`],
    })),
    ...overrides,
  };
}

function fixture({ evidenceAvailable = true, lifecycle = null, exposeProfileId = false } = {}) {
  const repository = new MemoryModelValidationRepository({
    idFactory: () => "00000000-0000-4000-8000-000000007704",
    clock: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  const audit = [];
  const service = new ModelValidationService({
    repository,
    profileCatalog: { async getByKey(key) { return key === "qwen.nvfp4.profile.r1" ? {
      fingerprint: profileFingerprint,
      ...(exposeProfileId ? { profile: { profileId: "00000000-0000-4000-8000-000000007705" } } : {}),
    } : null; } },
    engineJobs: {
      async getBuild(id) { return id === buildId ? { jobId: buildId, state: "succeeded", fingerprint: buildFingerprint } : null; },
      async getDeployment(id) { return id === deploymentId ? { jobId: deploymentId, state: "succeeded", fingerprint: deploymentFingerprint, specification: { buildJobId: buildId } } : null; },
    },
    evidenceStore: { async verify() { return evidenceAvailable; } },
    lifecycle,
    clock: () => new Date("2026-08-11T12:00:00.000Z"),
    audit: async (event) => audit.push(event),
  });
  return { audit, repository, service };
}

function stageResult(run, ordinal, outcome = "passed") {
  const specification = run.plan.stages[ordinal];
  const minute = String(ordinal * 2).padStart(2, "0");
  const nextMinute = String(ordinal * 2 + 1).padStart(2, "0");
  const result = {
    planFingerprint: run.fingerprint, stage: specification.stage, outcome,
    executorImage: specification.executorImage, suiteDigest: specification.suiteDigest,
    configurationDigest: specification.configurationDigest, environmentDigest: digest("8"),
    evidence: specification.evidenceKinds.map((kind) => ({
      kind, digest: digest("9"), sizeBytes: 128, mediaType: "application/json",
      reference: `object://model-validation/${run.runId}/${ordinal}`,
    })),
    metricsDigest: digest("1"), logDigest: digest("2"),
    startedAt: `2026-08-11T10:${minute}:00.000Z`,
    finishedAt: `2026-08-11T10:${nextMinute}:00.000Z`,
  };
  if (specification.stage === "quality" && outcome !== "incomplete") {
    result.qualityGate = {
      suiteDigest: specification.suiteDigest,
      corpusDigest: run.plan.corpusDigest,
      profileFingerprint: run.plan.profile.fingerprint,
      reportDigest: result.metricsDigest,
      outcome,
      failedMeasurements: outcome === "passed" ? 0 : 1,
    };
  }
  if (specification.stage === "benchmark" && outcome !== "incomplete") {
    result.benchmarkGate = {
      suiteDigest: specification.suiteDigest,
      inputSetDigest: run.plan.corpusDigest,
      profileFingerprint: run.plan.profile.fingerprint,
      reportDigest: result.metricsDigest,
      comparisonKey: digest("3"),
      outcome: outcome === "passed" ? "completed" : "failed",
      failedScenarios: outcome === "passed" ? 0 : 1,
    };
  }
  return result;
}

test("validation run fixes all ten ordered stages and deduplicates canonical plans", async () => {
  const state = fixture();
  const first = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-run-001" });
  assert.equal(first.created, true);
  assert.deepEqual(first.run.stages.map((item) => item.stage), MODEL_VALIDATION_STAGES);
  assert.deepEqual(first.run.stages.map((item) => item.state), ["queued", ...Array(9).fill("pending")]);
  assert.equal("operationKey" in first.run, false);
  const replay = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-run-002" });
  assert.equal(replay.created, false);
  assert.equal(replay.run.runId, first.run.runId);
});

test("every stage passes sequentially before the run can become certified", async () => {
  const state = fixture();
  let created = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-sequence-001" });
  for (let ordinal = 0; ordinal < MODEL_VALIDATION_STAGES.length; ordinal += 1) {
    const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
    assert.equal(claim.stage.stage, MODEL_VALIDATION_STAGES[ordinal]);
    assert.equal(claim.stage.claim, undefined);
    const internal = await state.repository.getRun(created.run.runId);
    const completed = await state.service.completeStage({
      context: worker, runId: created.run.runId, ordinal, claimToken: claim.claimToken,
      result: stageResult(internal, ordinal),
    });
    created = { run: completed.run };
    assert.equal(completed.stage.result.planFingerprint, internal.fingerprint);
  }
  assert.equal(created.run.state, "certified");
  assert.equal(created.run.stages.every((item) => item.state === "passed"), true);
  assert.equal(state.audit.filter((event) => event.event === "model_validation.stage_completed").length, 10);
});

test("validation orchestration projects active and terminal states into the model lifecycle", async () => {
  const lifecycleEvents = [];
  const state = fixture({
    exposeProfileId: true,
    lifecycle: {
      async beginValidation(input) { lifecycleEvents.push({ kind: "begin", ...input }); },
      async applyValidationOutcome(input) { lifecycleEvents.push({ kind: "outcome", ...input }); },
    },
  });
  const created = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-lifecycle-001" });
  for (let ordinal = 0; ordinal < MODEL_VALIDATION_STAGES.length; ordinal += 1) {
    const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
    const internal = await state.repository.getRun(created.run.runId);
    await state.service.completeStage({
      context: worker, runId: created.run.runId, ordinal, claimToken: claim.claimToken,
      result: stageResult(internal, ordinal),
    });
  }
  assert.deepEqual(lifecycleEvents.map((event) => event.kind), ["begin", "outcome"]);
  assert.equal(lifecycleEvents[0].validationRun.state, "validating");
  assert.equal(lifecycleEvents[1].validationRun.state, "certified");
});

test("a failed required stage is immutable and blocks every downstream stage", async () => {
  const state = fixture();
  const created = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-failed-001" });
  const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
  const internal = await state.repository.getRun(created.run.runId);
  const completed = await state.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 0, claimToken: claim.claimToken,
    result: stageResult(internal, 0, "failed"),
  });
  assert.equal(completed.run.state, "failed");
  assert.deepEqual(completed.run.stages.map((item) => item.state), ["failed", ...Array(9).fill("blocked")]);
  await assert.rejects(state.service.claimNextStage({ context: worker, runId: created.run.runId }), (error) => error.code === "model_validation_not_claimable");
});

test("claim fencing and protected evidence verification occur before immutable completion", async () => {
  const unavailable = fixture({ evidenceAvailable: false });
  const created = await unavailable.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-evidence-001" });
  const claim = await unavailable.service.claimNextStage({ context: worker, runId: created.run.runId });
  const internal = await unavailable.repository.getRun(created.run.runId);
  await assert.rejects(unavailable.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 0, claimToken: "wrong-fence",
    result: stageResult(internal, 0),
  }), (error) => error.code === "model_validation_fenced");
  await assert.rejects(unavailable.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 0, claimToken: claim.claimToken,
    result: stageResult(internal, 0),
  }), (error) => error.code === "model_validation_evidence_unavailable");
  assert.equal((await unavailable.repository.getRun(created.run.runId)).stages[0].state, "running");
});

test("missing stages, mutable executors, lineage drift, and personal users fail closed", async () => {
  const state = fixture();
  const missing = plan(); missing.stages.pop();
  await assert.rejects(state.service.createRun({ context: admin, plan: missing, operationKey: "model-validation-invalid-001" }), (error) => error.code === "model_validation_plan_invalid");
  const mutable = plan(); mutable.stages[0].executorImage = "registry.example.test/model-validation:latest";
  await assert.rejects(state.service.createRun({ context: admin, plan: mutable, operationKey: "model-validation-invalid-002" }), (error) => error.code === "model_validation_plan_invalid");
  const drift = plan(); drift.build.fingerprint = digest("7");
  await assert.rejects(state.service.createRun({ context: admin, plan: drift, operationKey: "model-validation-invalid-003" }), (error) => error.code === "model_validation_input_unavailable");
  await assert.rejects(state.service.createRun({ context: { permissions: [] }, plan: plan(), operationKey: "model-validation-denied-001" }), (error) => error.code === "model_manager_required");
});

test("quality stage cannot pass without a matching pinned quality report", async () => {
  const state = fixture();
  const created = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-quality-gate-001" });
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
    const internal = await state.repository.getRun(created.run.runId);
    await state.service.completeStage({
      context: worker, runId: created.run.runId, ordinal, claimToken: claim.claimToken,
      result: stageResult(internal, ordinal),
    });
  }
  const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
  const internal = await state.repository.getRun(created.run.runId);
  const missing = stageResult(internal, 4); delete missing.qualityGate;
  await assert.rejects(state.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 4, claimToken: claim.claimToken, result: missing,
  }), (error) => error.code === "model_validation_plan_invalid");
  const mismatched = stageResult(internal, 4);
  mismatched.qualityGate.corpusDigest = digest("7");
  await assert.rejects(state.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 4, claimToken: claim.claimToken, result: mismatched,
  }), (error) => error.code === "model_validation_quality_gate_failed");
  assert.equal((await state.repository.getRun(created.run.runId)).stages[4].state, "running");
});

test("benchmark stage cannot pass with missing, incomparable, or failed performance evidence", async () => {
  const state = fixture();
  const created = await state.service.createRun({ context: admin, plan: plan(), operationKey: "model-validation-benchmark-gate-001" });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
    const internal = await state.repository.getRun(created.run.runId);
    await state.service.completeStage({
      context: worker, runId: created.run.runId, ordinal, claimToken: claim.claimToken,
      result: stageResult(internal, ordinal),
    });
  }
  const claim = await state.service.claimNextStage({ context: worker, runId: created.run.runId });
  const internal = await state.repository.getRun(created.run.runId);
  const failedAsPassed = stageResult(internal, 5);
  failedAsPassed.benchmarkGate.outcome = "failed";
  failedAsPassed.benchmarkGate.failedScenarios = 1;
  await assert.rejects(state.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 5, claimToken: claim.claimToken, result: failedAsPassed,
  }), (error) => error.code === "model_validation_benchmark_gate_failed");
  const incomparable = stageResult(internal, 5);
  incomparable.benchmarkGate.comparisonKey = "not-a-digest";
  await assert.rejects(state.service.completeStage({
    context: worker, runId: created.run.runId, ordinal: 5, claimToken: claim.claimToken, result: incomparable,
  }), (error) => error.code === "model_validation_benchmark_gate_failed");
  assert.equal((await state.repository.getRun(created.run.runId)).stages[5].state, "running");
});
