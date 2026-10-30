import assert from "node:assert/strict";
import test from "node:test";

import { MemoryModelLifecycleRepository } from "../src/models/memory-model-lifecycle-repository.mjs";
import { ModelLifecycleService } from "../src/models/model-lifecycle-service.mjs";

const profileId = "00000000-0000-4000-8000-000000007801";
const secondProfileId = "00000000-0000-4000-8000-000000007802";
const validatingRunId = "00000000-0000-4000-8000-000000007803";
const certifiedRunId = "00000000-0000-4000-8000-000000007804";
const fingerprint = `sha256:${"a".repeat(64)}`;
const admin = { identityId: "00000000-0000-4000-8000-000000007805", permissions: ["model:manage"] };

function fixture() {
  let now = new Date("2026-08-11T04:00:00.000Z");
  const repository = new MemoryModelLifecycleRepository({ profiles: [
    { profileId, profileKey: "llm.spark.nvfp4.v1", fingerprint, state: "experimental", updatedAt: now },
    { profileId: secondProfileId, profileKey: "ocr.spark.v1", fingerprint: `sha256:${"b".repeat(64)}`, state: "experimental", updatedAt: now },
  ] });
  const runs = new Map([
    [validatingRunId, { runId: validatingRunId, state: "validating", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } } }],
    [certifiedRunId, { runId: certifiedRunId, state: "certified", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } } }],
  ]);
  const audit = [];
  const service = new ModelLifecycleService({
    repository,
    validationRuns: { async getRun(runId) { return structuredClone(runs.get(runId) ?? null); } },
    clock: () => new Date(now),
    audit: async (event) => audit.push(event),
  });
  return { service, repository, audit, advance(ms) { now = new Date(now.getTime() + ms); } };
}

test("requires exact validation lineage before certification and records ordered lifecycle evidence", async () => {
  const state = fixture();
  const validating = await state.service.transition({
    context: admin, profileId, expectedRevision: 1, nextState: "validating",
    reasonKey: "model.lifecycle.validation_started", validationRunId: validatingRunId,
    evidenceRefs: ["evidence://models/discovery"],
  });
  assert.equal(validating.state, "validating");
  assert.equal(validating.revision, 2);

  await assert.rejects(state.service.transition({
    context: admin, profileId, expectedRevision: 2, nextState: "certified",
    reasonKey: "model.lifecycle.certified", validationRunId: validatingRunId,
  }), (error) => error.code === "model_lifecycle_certification_blocked");

  const certified = await state.service.transition({
    context: admin, profileId, expectedRevision: 2, nextState: "certified",
    reasonKey: "model.lifecycle.certified", validationRunId: certifiedRunId,
    evidenceRefs: ["object://model-validation/final", "evidence://models/soak"],
  });
  assert.equal(certified.state, "certified");
  assert.equal(certified.validationRunId, certifiedRunId);
  assert.equal(certified.revision, 3);
  assert.deepEqual((await state.repository.listLifecycleEvents(profileId)).map((event) => event.toState), ["validating", "certified"]);
  assert.equal(state.audit.filter((event) => event.event === "model_profile.lifecycle_transitioned").length, 2);
});

test("administrator model listing is ordered, bounded, and cursor based", async () => {
  const state = fixture();
  const first = await state.service.listProfiles(admin, { limit: 1 });
  assert.equal(first.data.length, 1);
  assert.equal(first.data[0].profileKey, "llm.spark.nvfp4.v1");
  assert.equal(first.nextCursor, "llm.spark.nvfp4.v1");
  const second = await state.service.listProfiles(admin, { limit: 1, afterProfileKey: first.nextCursor });
  assert.equal(second.data[0].profileKey, "ocr.spark.v1");
  assert.equal(second.nextCursor, null);
  await assert.rejects(state.service.listProfiles({ permissions: [] }), (error) => error.code === "model_viewer_required");
  await assert.rejects(state.service.listProfiles(admin, { limit: 201 }), (error) => error.code === "model_lifecycle_input_invalid");
});

test("validation orchestration can atomically apply only its own terminal outcome", async () => {
  const state = fixture();
  const activeRun = await state.service.beginValidation({
    context: admin, profileId,
    validationRun: {
      runId: validatingRunId, state: "validating",
      plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } },
    },
  });
  assert.equal(activeRun.state, "validating");
  const terminal = {
    runId: validatingRunId, state: "certified",
    plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } },
    stages: [{ result: { evidence: [{ reference: "object://validation/final" }] } }],
  };
  const certified = await state.service.applyValidationOutcome({
    context: { workerId: "worker.spark.1", permissions: ["model:validate"] },
    profileId, validationRun: terminal,
  });
  assert.equal(certified.state, "certified");
  assert.deepEqual(certified.evidenceRefs, ["object://validation/final"]);
  await assert.rejects(state.service.applyValidationOutcome({
    context: { workerId: "worker.spark.2", permissions: ["model:validate"] },
    profileId, validationRun: terminal,
  }), (error) => error.code === "model_lifecycle_validation_mismatch");
});

test("a certified environment change raises Revalidation Required, fences certified routing, and clears only after a fresh validation", async () => {
  const state = fixture();
  await state.service.transition({
    context: admin, profileId, expectedRevision: 1, nextState: "validating",
    reasonKey: "model.lifecycle.validation_started", validationRunId: validatingRunId,
  });
  await state.service.transition({
    context: admin, profileId, expectedRevision: 2, nextState: "certified",
    reasonKey: "model.lifecycle.certified", validationRunId: certifiedRunId,
  });
  const stale = await state.service.transition({
    context: admin, profileId, expectedRevision: 3, nextState: "revalidation_required",
    reasonKey: "model.lifecycle.environment_changed",
    evidenceRefs: ["evidence://inventory/new-driver"],
  });
  assert.equal(stale.state, "revalidation_required");
  assert.equal(stale.validationRunId, null);
  assert.equal((await state.service.listProfiles(admin)).data.find((item) => item.profileId === profileId).state, "revalidation_required");

  const validating = await state.service.transition({
    context: admin, profileId, expectedRevision: 4, nextState: "validating",
    reasonKey: "model.lifecycle.revalidation_started", validationRunId: validatingRunId,
    evidenceRefs: ["evidence://inventory/new-driver"],
  });
  assert.equal(validating.state, "validating");
  const recovered = await state.service.transition({
    context: admin, profileId, expectedRevision: 5, nextState: "certified",
    reasonKey: "model.lifecycle.revalidation_passed", validationRunId: certifiedRunId,
    evidenceRefs: ["evidence://models/new-driver-validation"],
  });
  assert.equal(recovered.state, "certified");
  assert.equal(recovered.revision, 6);
});

test("a validation worker can automatically fence a Certified profile after drift", async () => {
  const state = fixture();
  await state.service.beginValidation({
    context: admin, profileId,
    validationRun: { runId: validatingRunId, state: "validating", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } } },
  });
  await state.service.applyValidationOutcome({
    context: { workerId: "worker.spark.1", permissions: ["model:validate"] }, profileId,
    validationRun: { runId: validatingRunId, state: "certified", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } }, stages: [] },
  });
  const stale = await state.service.requireRevalidation({
    context: { workerId: "inventory.spark.1", permissions: ["model:validate"] },
    profileId, reasonKey: "model.lifecycle.environment_changed",
    evidenceRefs: ["evidence://inventory/driver-change"],
  });
  assert.equal(stale.state, "revalidation_required");
  assert.equal(stale.validationRunId, null);
});

test("Experimental routing is explicit, profile-specific, expiring, and never enabled in production", async () => {
  const state = fixture();
  const optIn = await state.service.setExperimentalOptIn({
    context: admin, policyKey: "lab.spark", environment: "validation",
    profileId: secondProfileId, enabled: true,
    reasonKey: "model.routing.experimental_validation",
    expiresAt: "2026-08-12T04:00:00.000Z",
  });
  assert.equal(optIn.enabled, true);
  assert.deepEqual((await state.service.routingPolicy({
    policyKey: "lab.spark", environment: "validation",
  })).experimentalProfileIds, [secondProfileId]);
  assert.deepEqual((await state.service.routingPolicy({
    policyKey: "lab.spark", environment: "production",
  })).experimentalProfileIds, []);
  await assert.rejects(state.service.setExperimentalOptIn({
    context: admin, policyKey: "lab.spark", environment: "production",
    profileId: secondProfileId, enabled: true,
    reasonKey: "model.routing.experimental_validation",
    expiresAt: "2026-08-12T04:00:00.000Z",
  }), (error) => error.code === "model_experimental_policy_invalid");
  state.advance(25 * 3600_000);
  assert.deepEqual((await state.service.routingPolicy({
    policyKey: "lab.spark", environment: "validation",
  })).experimentalProfileIds, []);
});

test("unauthorized, stale-revision, illegal-transition, and mismatched-lineage changes fail closed", async () => {
  const state = fixture();
  await assert.rejects(state.service.getProfile({ permissions: [] }, profileId), (error) => error.code === "model_viewer_required");
  await assert.rejects(state.service.transition({
    context: admin, profileId, expectedRevision: 2, nextState: "validating",
    reasonKey: "model.lifecycle.validation_started", validationRunId: validatingRunId,
  }), (error) => error.code === "model_lifecycle_revision_conflict");
  await assert.rejects(state.service.transition({
    context: admin, profileId, expectedRevision: 1, nextState: "certified",
    reasonKey: "model.lifecycle.certified", validationRunId: certifiedRunId,
  }), (error) => error.code === "model_lifecycle_transition_invalid");
  await assert.rejects(state.service.transition({
    context: admin, profileId: secondProfileId, expectedRevision: 1, nextState: "validating",
    reasonKey: "model.lifecycle.validation_started", validationRunId: validatingRunId,
  }), (error) => error.code === "model_lifecycle_validation_mismatch");
});
