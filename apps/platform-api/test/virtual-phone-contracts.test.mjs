import assert from "node:assert/strict";
import { test } from "node:test";
import { PHONE_SPEC, PHONE_POLICY, assertTransition, validatePolicy, validateCreate, validateAction,
  validateRename, validateQuota, validateQuotaQuery, validateGrant, validateRunIdentity, requestFingerprint, idempotencyKey, failPhone,
} from "../src/virtual-phones/contracts.mjs";

const invalid = fn => assert.throws(fn, { code: "phone_input_invalid" });
test("virtual phones start disabled with the tested ARM64 envelope and deferred Play", () => {
  assert.equal(PHONE_POLICY.enabled, false);
  assert.equal(PHONE_SPEC.memoryBytes, 6 * 1024 ** 3);
  assert.equal(PHONE_SPEC.storageBytes, 16 * 1024 ** 3);
  assert.equal(PHONE_SPEC.googlePlay, "deferred");
  assert.equal(PHONE_SPEC.renderer, "swiftshader");
  assert.equal(PHONE_SPEC.buildId, "16102939");
  assert.deepEqual(validateCreate({ name: "  办公手机  " }), { name: "办公手机", start: true });
});
test("create is a closed user contract, not a runtime command", () => {
  for (const input of [null, [], {}, { name: "" }, { name: "x\n" }, { name: "x\u202E" },
    { name: "ok", ownerId: "other" }, { name: "ok", image: "host" }, { name: "ok", mounts: [] },
    { name: "ok", nodeId: "node" }, { name: "ok", start: "true" }]) invalid(() => validateCreate(input));
  assert.deepEqual(validateCreate({ name: "é", start: false }), validateCreate({ name: "e\u0301", start: false }));
});
test('phone names and directory searches have no invented character quota', () => {
  const name='办公手机📱'.repeat(1000);
  assert.equal(validateCreate({name}).name,name);
  assert.equal(validateRename({name,expectedRevision:1}).name,name);
  assert.equal(validateQuotaQuery({search:name}).search,name);
});
test("lifecycle and deletion require a positive expected revision and explicit deletion", () => {
  for (const action of ["start", "stop", "restart", "delete"]) invalid(() => validateAction(action, {}));
  invalid(() => validateAction("exec", { expectedRevision: 1 }));
  invalid(() => validateAction("delete", { expectedRevision: 1, confirmDelete: "yes" }));
  assert.deepEqual(validateAction("delete", { expectedRevision: 1, confirmDelete: true }), { expectedRevision: 1, confirmDelete: true });
  invalid(() => validateRename({ name: "new", expectedRevision: 0 }));
  assert.deepEqual(validateRename({ name: " new ", expectedRevision: 2 }), { name: "new", expectedRevision: 2 });
});
test("administrator count policy is independent of real memory and storage admission", () => {
  assert.equal(validatePolicy({phonesPerNode:20}).phonesPerNode,20);
  assert.equal(validatePolicy().phonesPerNode,null);
  assert.equal(validatePolicy().storedPerUser, null);
  assert.equal(validatePolicy().runningPerUser, null);
  assert.equal(validatePolicy({runningPerUser: 3}).runningPerUser, 3);
  assert.deepEqual(validateQuota({storedPerUser:null,runningPerUser:null}),{storedPerUser:null,runningPerUser:null});
  invalid(() => validateQuota({storedPerUser:null}));
  for (const input of [{ enabled: "true" }, { phonesPerNode: -1 }, { memoryBytes: 1 },
    { storedPerUser: -1 }, { maximumUploadBytes: PHONE_POLICY.maximumUploadBytes + 1 }]) invalid(() => validatePolicy(input));
  assert.equal(validatePolicy({ storedPerUser: 10, runningPerUser: 2 }).storedPerUser, 10);
  assert.deepEqual(validateQuota({storedPerUser:500,runningPerUser:20}),{storedPerUser:500,runningPerUser:20});
  invalid(() => validateQuota({ storedPerUser: 1, runningPerUser: 2 }));
  assert.deepEqual(validateQuota({ storedPerUser: 0, runningPerUser: 0 }), { storedPerUser: 0, runningPerUser: 0 });
});
test("stale identities, arbitrary grants and unbounded lifetimes are rejected", () => {
  invalid(() => validateRunIdentity({}));
  for (const kind of ["control", "adb"]) {
    assert.ok(validateGrant({ kind }).ttlSeconds <= (kind === "adb" ? 900 : 60));
    invalid(() => validateGrant({ kind, ttlSeconds: kind === "adb" ? 901 : 61 }));
  }
  invalid(() => validateGrant({ kind: "shell" }));
  invalid(() => validateGrant({ kind: "adb", ownerId: "other" }));
});
test("idempotency is normalized and error/state vocabularies are closed", () => {
  assert.equal(requestFingerprint({ b: 1, a: 2 }), requestFingerprint({ a: 2, b: 1 }));
  assert.notEqual(requestFingerprint({ name: "one" }), requestFingerprint({ name: "two" }));
  assert.equal(idempotencyKey("request-1234"), "request-1234");
  assert.throws(() => idempotencyKey(["request-1234"]), { code: "phone_idempotency_required" });
  assertTransition("starting", "running");
  for (const pair of [["deleted", "starting"], ["stopped", "running"], ["nope", "stopped"]]) {
    assert.throws(() => assertTransition(...pair), { code: "phone_state_conflict" });
  }
  assert.throws(() => failPhone("unknown_error"), TypeError);
});
