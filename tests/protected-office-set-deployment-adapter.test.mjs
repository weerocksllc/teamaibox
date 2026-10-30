import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  dispatchProtectedOfficeSetAction, protectedOfficeActionIdentity,
} from "../tools/protected_office_set_deployment_adapter.mjs";
import { inspectProtectedOfficeSet } from "../tools/protected_office_set_inspection_adapter.mjs";

const source = Buffer.from("export const pinned = true;\n");
const sourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;

function request(overrides = {}) {
  const runId = "protected-office-set-deployment-20260904-a1";
  const action = "preflight";
  const identity = protectedOfficeActionIdentity(runId, action);
  return {
    schemaVersion: 1,
    protocol: "teamaibox.protected-office-set-driver.v1",
    runId, action, ...identity,
    nonce: "abcdefghijklmnopqrstuv",
    driverModulePath: "/opt/teamaibox/apps/platform-api/protected-office-driver.mjs",
    driverModuleDigest: sourceDigest,
    plan: { deploymentId: "teamaibox.protected-office-set-deployment.v2" },
    ...overrides,
  };
}

function dependencies(result = { mutationCount: 0 }) {
  let closed = 0;
  return {
    read: async () => source,
    load: async () => ({
      createProtectedOfficeSetDeploymentDriver: async () => ({
        preflight: async ({ runId, actionId, idempotencyKey, nonce, plan }) => ({
          ...result, runIdObserved: runId, nonceObserved: nonce,
          actionIdObserved: actionId, idempotencyKeyObserved: idempotencyKey,
          planObserved: plan.deploymentId,
        }),
        close: async () => { closed += 1; },
      }),
    }),
    environment: {},
    closed: () => closed,
  };
}

test("dispatches one action through a digest-pinned production driver", async () => {
  const values = dependencies();
  const result = await dispatchProtectedOfficeSetAction(request(), values);
  assert.equal(result.status, "passed");
  assert.equal(result.action, "preflight");
  assert.equal(result.actionId, protectedOfficeActionIdentity(result.runId, result.action).actionId);
  assert.equal(result.result.mutationCount, 0);
  assert.equal(result.result.planObserved, "teamaibox.protected-office-set-deployment.v2");
  assert.equal(values.closed(), 1);
});

test("dispatches a v5 action through the same deterministic adapter boundary", async () => {
  const values = dependencies();
  const runId = "protected-office-set-deployment-v5-20260906-a1";
  const action = "preflight";
  const result = await dispatchProtectedOfficeSetAction(request({
    runId,
    ...protectedOfficeActionIdentity(runId, action),
    plan: { deploymentId: "teamaibox.protected-office-set-deployment.v5" },
  }), values);
  assert.equal(result.status, "passed");
  assert.equal(result.runId, runId);
  assert.equal(result.result.planObserved, "teamaibox.protected-office-set-deployment.v5");
});

test("rejects valid-looking but non-deterministic action journal identities", async () => {
  const values = dependencies();
  await assert.rejects(dispatchProtectedOfficeSetAction(request({
    actionId: "00000000-0000-4000-8000-000000000001",
  }), values), /request is invalid/);
  assert.equal(values.closed(), 0);
});

test("fails before dispatch when the production driver digest drifts", async () => {
  const values = dependencies();
  await assert.rejects(
    dispatchProtectedOfficeSetAction(request({ driverModuleDigest: `sha256:${"0".repeat(64)}` }), values),
    /digest drifted/,
  );
  assert.equal(values.closed(), 0);
});

test("rejects a sensitive result field and still closes the driver", async () => {
  const values = dependencies({ accessToken: "must-not-cross-adapter" });
  await assert.rejects(dispatchProtectedOfficeSetAction(request(), values), /sensitive field/);
  assert.equal(values.closed(), 1);
});

test("does not provide a simulated fallback when the production driver is missing", async () => {
  await assert.rejects(dispatchProtectedOfficeSetAction(request(), {
    read: async () => source,
    load: async () => ({}),
    environment: {},
  }), /factory is unavailable/);
});

test("strict inspection boundary only accepts an explicitly read-only result", async () => {
  const inspection = {
    schemaVersion: 1, protocol: "teamaibox.protected-office-set-inspection.v1",
    runId: "protected-office-set-deployment-20260904-a1",
    nonce: "abcdefghijklmnopqrstuv",
    inspectorModulePath: "/opt/teamaibox/apps/platform-api/protected-office-inspector.mjs",
    inspectorModuleDigest: sourceDigest,
    plan: { deploymentId: "teamaibox.protected-office-set-deployment.v2" },
  };
  const result = await inspectProtectedOfficeSet(inspection, {
    read: async () => source,
    load: async () => ({ inspectProtectedOfficeSetDeployment: async () => ({
      readOnly: true, mutationCount: 0, inspectionSources: ["postgres"],
    }) }),
    environment: {},
  });
  assert.equal(result.status, "passed");
  assert.equal(result.result.mutationCount, 0);
  await assert.rejects(inspectProtectedOfficeSet(inspection, {
    read: async () => source,
    load: async () => ({ inspectProtectedOfficeSetDeployment: async () => ({
      readOnly: false, mutationCount: 1,
    }) }),
    environment: {},
  }), /read-only contract/);
});

test("strict inspection boundary accepts the bounded v5 run identity", async () => {
  const runId = "protected-office-set-deployment-v5-20260906-a2";
  const result = await inspectProtectedOfficeSet({
    schemaVersion: 1, protocol: "teamaibox.protected-office-set-inspection.v1",
    runId,
    nonce: "abcdefghijklmnopqrstuv",
    inspectorModulePath: "/opt/teamaibox/apps/platform-api/protected-office-inspector.mjs",
    inspectorModuleDigest: sourceDigest,
    plan: { deploymentId: "teamaibox.protected-office-set-deployment.v5" },
  }, {
    read: async () => source,
    load: async () => ({ inspectProtectedOfficeSetDeployment: async () => ({
      readOnly: true, mutationCount: 0, inspectionSources: ["postgres"],
    }) }),
    environment: {},
  });
  assert.equal(result.status, "passed");
  assert.equal(result.runId, runId);
});
