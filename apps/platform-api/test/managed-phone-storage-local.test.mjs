import assert from "node:assert/strict";
import test from "node:test";
import { ManagedPhoneStorageRepository } from "../src/storage/managed-phone-storage-repository.mjs";

const LOCAL = "00000000-0000-4000-8000-000000000020";
const FOREIGN = "00000000-0000-4000-8000-000000000019";
const approved = { nodeId: LOCAL, nodeGeneration: 1, poolId: "phone-data", imageDigest: `sha256:${"a".repeat(64)}`, maximumPhones: null };
const unavailable = () => assert.fail("foreign storage must not reach an executor or database");

function repository(approvedNodes = [approved]) {
  return new ManagedPhoneStorageRepository({ localNodeId: LOCAL, approvedNodes,
    repository: { bindContext() { return { create: unavailable }; } },
    database: { transaction: unavailable }, nodeAgentRouter: { resolvePhoneNode: unavailable, readPhoneStorage: unavailable },
  });
}

test("storage configuration accepts only the local installation", () => {
  assert.ok(repository());
  assert.throws(() => repository([{ ...approved, nodeId: FOREIGN }]), /single local appliance/);
  assert.throws(() => repository([approved, { ...approved, poolId: "other-phone-data", nodeId: FOREIGN }]), /single local appliance/);
});

test("foreign pool registration cannot fall through to ordinary storage registration", async () => {
  const scoped = repository().bindContext({ identityId: LOCAL, permissions: ["storage:manage"] });
  for (const dataClasses of [["phone-data"], ["team-file"]]) {
    await assert.rejects(scoped.create({ nodeId: FOREIGN, poolId: "other-data", dataClasses }), { code: "phone_storage_unavailable" });
  }
});
