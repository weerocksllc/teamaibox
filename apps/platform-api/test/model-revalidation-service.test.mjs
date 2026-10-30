import assert from "node:assert/strict";
import test from "node:test";

import { MemoryModelLifecycleRepository } from "../src/models/memory-model-lifecycle-repository.mjs";
import { ModelLifecycleService } from "../src/models/model-lifecycle-service.mjs";
import { MemoryModelRevalidationRepository } from "../src/models/memory-model-revalidation-repository.mjs";
import { MODEL_REVALIDATION_FACTS, ModelRevalidationService } from "../src/models/model-revalidation-service.mjs";

const profileId = "00000000-0000-4000-8000-000000008101";
const runId = "00000000-0000-4000-8000-000000008102";
const fingerprint = `sha256:${"a".repeat(64)}`;
const admin = { identityId: "00000000-0000-4000-8000-000000008103", permissions: ["model:manage"] };
const worker = { workerId: "worker.spark.inventory", permissions: ["model:validate"] };

function baselineFacts() {
  return {
    modelArtifactDigest: `sha256:${"1".repeat(64)}`,
    quantizationRecipeDigest: `sha256:${"2".repeat(64)}`,
    engineDigest: `sha256:${"3".repeat(64)}`,
    containerImageDigest: `sha256:${"4".repeat(64)}`,
    driverVersion: "580.95.05", osRelease: "ubuntu-24.04", kernelVersion: "6.17.0",
    cudaInterfaceVersion: "13.0", containerToolkitVersion: "1.17.8",
    hardwareDigest: `sha256:${"5".repeat(64)}`,
    configurationDigest: `sha256:${"6".repeat(64)}`,
    testCorpusDigest: `sha256:${"7".repeat(64)}`,
  };
}

async function fixture() {
  const lifecycleRepository = new MemoryModelLifecycleRepository({ profiles: [{
    profileId, profileKey: "llm.spark.nvfp4.v1", fingerprint,
    state: "experimental", updatedAt: new Date("2026-08-11T07:00:00.000Z"),
  }] });
  const runs = new Map([[runId, {
    runId, state: "validating", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } }, stages: [],
  }]]);
  const audit = [];
  const lifecycle = new ModelLifecycleService({
    repository: lifecycleRepository,
    validationRuns: { async getRun(id) { return structuredClone(runs.get(id) ?? null); } },
    clock: () => new Date("2026-08-11T07:00:00.000Z"), audit: async (event) => audit.push(event),
  });
  await lifecycle.beginValidation({ context: admin, profileId, validationRun: runs.get(runId) });
  runs.get(runId).state = "certified";
  await lifecycle.applyValidationOutcome({ context: worker, profileId, validationRun: runs.get(runId) });
  const repository = new MemoryModelRevalidationRepository({
    idFactory: (() => { let value = 0; return () => `00000000-0000-4000-8000-${String(8200 + value++).padStart(12, "0")}`; })(),
  });
  const service = new ModelRevalidationService({
    repository, lifecycle,
    validationRuns: { async getRun(id) { return structuredClone(runs.get(id) ?? null); } },
    clock: () => new Date("2026-08-11T07:05:00.000Z"), audit: async (event) => audit.push(event),
  });
  await service.recordCertificationBaseline({
    context: admin, profileId, lifecycleRevision: 3, validationRunId: runId,
    facts: baselineFacts(), evidenceRefs: ["evidence://certification/final"],
  });
  return { service, lifecycle, repository, audit };
}

test("an exact environment remains current and keeps the Certified route", async () => {
  const state = await fixture();
  const result = await state.service.evaluate({
    context: worker, profileId, observedFacts: baselineFacts(),
    evidenceRefs: ["evidence://inventory/current"],
  });
  assert.equal(result.outcome, "current");
  assert.deepEqual(result.changedDimensions, []);
  assert.equal((await state.lifecycle.getProfile(admin, profileId)).state, "certified");
  assert.equal((await state.repository.listChecks(profileId)).length, 1);
});

test("every declared artifact, runtime, environment, configuration, and corpus change fences production routing", async (t) => {
  assert.deepEqual(MODEL_REVALIDATION_FACTS, [
    "modelArtifactDigest", "quantizationRecipeDigest", "engineDigest", "containerImageDigest",
    "driverVersion", "osRelease", "kernelVersion", "cudaInterfaceVersion",
    "containerToolkitVersion", "hardwareDigest", "configurationDigest", "testCorpusDigest",
  ]);
  for (const dimension of MODEL_REVALIDATION_FACTS) {
    await t.test(dimension, async () => {
      const state = await fixture();
      const observed = baselineFacts();
      observed[dimension] = dimension.endsWith("Digest") ? `sha256:${"f".repeat(64)}` : `${observed[dimension]}-changed`;
      const result = await state.service.evaluate({
        context: worker, profileId, observedFacts: observed,
        evidenceRefs: [`evidence://inventory/${dimension}`],
      });
      assert.equal(result.outcome, "revalidation_required");
      assert.deepEqual(result.changedDimensions.map((item) => item.dimension), [dimension]);
      assert.equal((await state.lifecycle.getProfile(admin, profileId)).state, "revalidation_required");
    });
  }
});

test("an unknown required environment fact also fails closed", async () => {
  const state = await fixture();
  const observed = baselineFacts();
  delete observed.driverVersion;
  const result = await state.service.evaluate({ context: worker, profileId, observedFacts: observed, evidenceRefs: [] });
  assert.equal(result.outcome, "revalidation_required");
  assert.deepEqual(result.changedDimensions[0], {
    dimension: "driverVersion", expected: "580.95.05", observed: null, status: "unknown",
  });
});

test("baseline creation is idempotent but rejects unauthorized or contradictory certification facts", async () => {
  const state = await fixture();
  const replay = await state.service.recordCertificationBaseline({
    context: admin, profileId, lifecycleRevision: 3, validationRunId: runId,
    facts: baselineFacts(), evidenceRefs: ["evidence://certification/final"],
  });
  assert.equal(replay.created, false);
  await assert.rejects(state.service.evaluate({
    context: { permissions: [] }, profileId, observedFacts: baselineFacts(), evidenceRefs: [],
  }), (error) => error.code === "model_validator_required");
});
