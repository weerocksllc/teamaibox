import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ProductionProtectedOfficeSetDeploymentDriver,
  ProductionProtectedOfficeSetDeploymentInspector,
  protectedOfficeDeploymentActions,
  protectedOfficeDeploymentInspectionSources,
  protectedOfficeDeploymentProductionComponents,
} from "../src/protected-office-set-deployment-driver.mjs";
import { protectedOfficeDeploymentResultDigest } from "../src/postgres-protected-office-deployment-action-repository.mjs";

const RUN = "protected-office-set-deployment-20260905-a1";
const ACTION_ID = "00000000-0000-4000-8000-000000000101";
const IDEMPOTENCY = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-09-05T05:00:00.000Z");

function request(action = "preflight", runId = RUN) {
  return { runId, action, actionId: ACTION_ID, idempotencyKey: IDEMPOTENCY,
    nonce: "abcdefghijklmnopqrstuv", plan: { schemaVersion: 1, target: { nodeId: ACTION_ID } } };
}

function baseResult() {
  return { node: { nodeId: ACTION_ID }, proof: { audit: { chainVerified: true } }, profiles: [] };
}

function journal(overrides = {}) {
  return { runId: RUN, action: "preflight", actionId: ACTION_ID, idempotencyKey: IDEMPOTENCY,
    requestDigest: `sha256:${"b".repeat(64)}`, revision: 1, state: "running", recoveryCount: 0,
    resultDigest: null, result: null, failureCode: null, createdAt: NOW, updatedAt: NOW,
    persistedAt: null, created: true, ...overrides };
}

function executor(overrides = {}) {
  const value = { async recoverInterruptedAction() {} };
  for (const action of protectedOfficeDeploymentActions) value[action] = async () => baseResult();
  return Object.assign(value, overrides);
}

test("driver journals before execution and injects only factory-owned production claims", async () => {
  const calls = [];
  const repository = {
    async beginAction(value) { calls.push(["begin", value]); return journal({ requestDigest: value.requestDigest }); },
    async completeAction(runId, action, revision, value) {
      calls.push(["complete", runId, action, revision, value]);
      return journal({ revision: 2, state: "succeeded", result: value.result,
        resultDigest: value.resultDigest, persistedAt: NOW, created: undefined });
    },
    async markRecovering() { throw new Error("unused"); }, async resumeAction() { throw new Error("unused"); },
    async failAction() { throw new Error("unused"); },
  };
  const result = await new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository: repository, actionExecutor: executor(), clock: () => NOW,
  }).preflight(request());
  assert.deepEqual(calls.map((item) => item[0]), ["begin", "complete"]);
  assert.deepEqual(result.productionComponents, [...protectedOfficeDeploymentProductionComponents]);
  assert.equal(result.nodeAgentTransport, "mtls-hmac");
  assert.equal(result.proof.actionJournal.state, "succeeded");
  assert.equal(calls[1][4].resultDigest, protectedOfficeDeploymentResultDigest(calls[1][4].result));
});

test("driver accepts the bounded v5 run identity and journals it exactly", async () => {
  const runId = "protected-office-set-deployment-v5-20260906-a6";
  let observed = null;
  const repository = {
    async beginAction(value) {
      observed = value;
      return journal({ runId, requestDigest: value.requestDigest });
    },
    async completeAction(_runId, _action, _revision, value) {
      return journal({ runId, revision: 2, state: "succeeded", result: value.result,
        resultDigest: value.resultDigest, persistedAt: NOW, created: undefined });
    },
    async markRecovering() { throw new Error("unused"); }, async resumeAction() { throw new Error("unused"); },
    async failAction() { throw new Error("unused"); },
  };
  const input = request("preflight", runId);
  input.plan.workerStart = { environment: {
    TIKTOKEN_CACHE_DIR: "/tmp/tiktoken",
    MAX_NEW_TOKENS: "4096",
    DFLASH_NUM_SPECULATIVE_TOKENS: "15",
    OCR_MANAGED_PROVIDER_TOKEN_FILE: "/run/secrets/auth/provider.token",
  } };
  input.plan.set = { profiles: [{
    priorState: { authority: { leaseId: ACTION_ID, fencingToken: 11, nodeGeneration: 1 } },
  }] };
  const result = await new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository: repository, actionExecutor: executor(), clock: () => NOW,
  }).preflight(input);
  assert.equal(observed.runId, runId);
  assert.equal(result.proof.actionJournal.runId, runId);
});

test("driver treats only a positive integer fencingToken as a non-secret concurrency counter", async () => {
  let began = false;
  const repository = {
    async beginAction() { began = true; throw new Error("stop after request validation"); },
    async markRecovering() {}, async resumeAction() {}, async completeAction() {}, async failAction() {},
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository: repository, actionExecutor: executor(),
  });
  const accepted = request("preflight", "protected-office-set-deployment-v5-20260906-a7");
  accepted.plan.authority = { fencingToken: 11 };
  await assert.rejects(driver.preflight(accepted), /stop after request validation/);
  assert.equal(began, true);

  began = false;
  const rejected = request("preflight", "protected-office-set-deployment-v5-20260906-a8");
  rejected.plan.authority = { fencingToken: "credential-shaped-value" };
  await assert.rejects(driver.preflight(rejected), /sensitive field/);
  assert.equal(began, false);
});

test("driver permits only bounded secret-file references in plans", async () => {
  let began = false;
  const repository = {
    async beginAction() { began = true; throw new Error("must not begin"); },
    async markRecovering() {}, async resumeAction() {}, async completeAction() {}, async failAction() {},
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository: repository, actionExecutor: executor(),
  });
  const raw = request();
  raw.plan.environment = { OCR_MANAGED_PROVIDER_TOKEN_FILE: "actual-secret-content" };
  await assert.rejects(driver.preflight(raw), /sensitive field/);
  assert.equal(began, false);
});

test("driver recovers a non-terminal prior action before replay", async () => {
  const calls = [];
  const repository = {
    async beginAction() { return journal({ created: false }); },
    async markRecovering(runId, action, revision) { calls.push("recovering"); return journal({ created: false, revision: revision + 1, state: "recovering", recoveryCount: 1 }); },
    async resumeAction(runId, action, revision) { calls.push("resumed"); return journal({ created: false, revision: revision + 1, state: "running", recoveryCount: 1 }); },
    async completeAction(runId, action, revision, value) { calls.push("completed"); return journal({ revision: revision + 1,
      state: "succeeded", result: value.result, resultDigest: value.resultDigest, persistedAt: NOW }); },
    async failAction() { throw new Error("unused"); },
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository: repository,
    actionExecutor: executor({ async recoverInterruptedAction() { calls.push("recovered"); },
      async preflight() { calls.push("executed"); return baseResult(); } }),
    clock: () => NOW,
  });
  await driver.preflight(request());
  assert.deepEqual(calls, ["recovering", "recovered", "resumed", "executed", "completed"]);
});

test("driver replays a succeeded redacted result but never retries a failed run", async () => {
  const durable = { ...baseResult(), productionComponents: [...protectedOfficeDeploymentProductionComponents],
    nodeAgentTransport: "mtls-hmac", schedulerRepository: "postgres", nodeAgentJournalPersisted: true };
  const repository = {
    async beginAction() { return journal({ state: "succeeded", revision: 3, created: false,
      result: durable, resultDigest: protectedOfficeDeploymentResultDigest(durable), persistedAt: NOW }); },
    async markRecovering() {}, async resumeAction() {}, async completeAction() {}, async failAction() {},
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({ actionRepository: repository,
    actionExecutor: executor({ async preflight() { throw new Error("must not execute"); } }) });
  assert.equal((await driver.preflight(request())).proof.actionJournal.revision, 3);
  repository.beginAction = async () => journal({ state: "failed", created: false, failureCode: "stage_failed", persistedAt: NOW });
  await assert.rejects(driver.preflight(request()), { code: "protected_deployment_action_terminal", retryable: false });
});

test("driver terminally journals unsafe or failed executor results", async () => {
  let failure = null;
  const repository = {
    async beginAction(value) { return journal({ requestDigest: value.requestDigest }); },
    async markRecovering() {}, async resumeAction() {}, async completeAction() {},
    async failAction(runId, action, revision, value) { failure = value; return journal({ state: "failed" }); },
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({ actionRepository: repository,
    actionExecutor: executor({ async preflight() { return { ...baseResult(), accessToken: "forbidden" }; } }),
    clock: () => NOW });
  await assert.rejects(driver.preflight(request()), {
    code: "protected_deployment_result_sensitive_field",
  });
  assert.equal(failure.failureCode, "protected_deployment_result_sensitive_field");
});

test("driver journals executor TypeErrors under a stable non-secret stage code", async () => {
  let failure = null;
  const repository = {
    async beginAction(value) { return journal({ requestDigest: value.requestDigest }); },
    async markRecovering() {}, async resumeAction() {}, async completeAction() {},
    async failAction(runId, action, revision, value) { failure = value; return journal({ state: "failed" }); },
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({ actionRepository: repository,
    actionExecutor: executor({ async preflight() { throw new TypeError("credential-shaped implementation detail"); } }),
    clock: () => NOW });
  await assert.rejects(driver.preflight(request()), (error) => {
    assert.equal(error.code, "protected_deployment_executor_type_error");
    assert.equal(error.details.stage, "executor");
    assert.match(error.details.sourceLocation, /^protected-office-set-deployment-driver.test.mjs:\d+:\d+$/);
    assert.equal(JSON.stringify(error.details).includes("credential-shaped"), false);
    return true;
  });
  assert.equal(failure.failureCode, "protected_deployment_executor_type_error");
});

test("driver journals persistence TypeErrors under a stable non-secret stage code", async () => {
  let failure = null;
  const repository = {
    async beginAction(value) { return journal({ requestDigest: value.requestDigest }); },
    async markRecovering() {}, async resumeAction() {},
    async completeAction() { throw new TypeError("database adapter detail"); },
    async failAction(runId, action, revision, value) { failure = value; return journal({ state: "failed" }); },
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({ actionRepository: repository,
    actionExecutor: executor(), clock: () => NOW });
  await assert.rejects(driver.preflight(request()), {
    code: "protected_deployment_result_persistence_type_error",
  });
  assert.equal(failure.failureCode, "protected_deployment_result_persistence_type_error");
});

test("driver classifies a non-integer result without retaining its value", async () => {
  let failure = null;
  const repository = {
    async beginAction(value) { return journal({ requestDigest: value.requestDigest }); },
    async markRecovering() {}, async resumeAction() {},
    async completeAction(runId, action, revision, value) {
      protectedOfficeDeploymentResultDigest(value.result);
      throw new Error("unreachable");
    },
    async failAction(runId, action, revision, value) { failure = value; return journal({ state: "failed" }); },
  };
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({ actionRepository: repository,
    actionExecutor: executor({ async preflight() {
      return { ...baseResult(), aggregateMemory: { freshnessSeconds: 1.5 } };
    } }),
    clock: () => NOW });
  await assert.rejects(driver.preflight(request()), {
    code: "protected_deployment_result_unsafe_number",
  });
  assert.equal(failure.failureCode, "protected_deployment_result_unsafe_number");
});

test("independent inspector requires all seven read-only sources and an existing successful journal", async () => {
  const sourceCalls = [];
  const sources = Object.fromEntries(protectedOfficeDeploymentInspectionSources.map((name) => [name, async () => {
    sourceCalls.push(name); return { readOnly: true, mutationCount: 0, factDigest: `sha256:${createHash("sha256").update(name).digest("hex")}` };
  }]));
  const result = baseResult();
  const persisted = { ...result, productionComponents: [...protectedOfficeDeploymentProductionComponents],
    nodeAgentTransport: "mtls-hmac", schedulerRepository: "postgres", nodeAgentJournalPersisted: true };
  const action = journal({ state: "succeeded", revision: 4, result: persisted,
    resultDigest: protectedOfficeDeploymentResultDigest(persisted), persistedAt: NOW });
  const inspector = new ProductionProtectedOfficeSetDeploymentInspector({
    actionRepository: { async getAction() { return action; } }, inspectionSources: sources,
    async resultAssembler({ sources: observed }) {
      assert.deepEqual(Object.keys(observed), [...protectedOfficeDeploymentInspectionSources]);
      return result;
    },
  });
  const observed = await inspector.inspect({ runId: RUN, nonce: "abcdefghijklmnopqrstuv", plan: request().plan });
  assert.deepEqual(sourceCalls, [...protectedOfficeDeploymentInspectionSources]);
  assert.equal(observed.readOnly, true);
  assert.equal(observed.mutationCount, 0);
  assert.deepEqual(observed.inspectionSources, [...protectedOfficeDeploymentInspectionSources]);

  sources["casting-session"] = async () => ({ readOnly: false, mutationCount: 1 });
  await assert.rejects(inspector.inspect({ runId: RUN, nonce: "abcdefghijklmnopqrstuv", plan: request().plan }),
    { code: "protected_deployment_inspection_source_invalid" });
});
