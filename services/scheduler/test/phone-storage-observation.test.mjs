import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneStorageObservation } from "../src/phone-storage-observation.mjs";
import { ProtectedNodeAgentClient } from "../src/protected-node-agent-client.mjs";
import { ManagedNodeAgentRouter } from '../src/managed-node-agent-router.mjs';

const nodeId = "00000000-0000-4000-8000-000000000101", nodeGeneration = 2;
const now = new Date(), value = { nodeId, nodeGeneration, poolId: "phone.pool", luksUUID: nodeId, filesystemUUID: nodeId,
  totalBytes: 64 * 2 ** 30, availableBytes: 60 * 2 ** 30, quotaBytes: 16 * 2 ** 30, reserveBytes: 0, observedAt: now.toISOString() };
test("storage observation rejects stale, malformed, foreign and path-bearing results", () => {
  assert.deepEqual(phoneStorageObservation(value, { nodeId, nodeGeneration, poolId: "phone.pool", now }), value);
  for (const changes of [{ nodeGeneration: 1 }, { poolId: "foreign.pool" }, { totalBytes: null }, { availableBytes: 65 * 2 ** 30 },
    { availableBytes: -1 }, { quotaBytes: 0 }, { root: "/host/data" }, { luksUUID: "unknown" },
    { observedAt: new Date(+now - 10001).toISOString() }, { observedAt: new Date(+now + 1001).toISOString() }]) {
    assert.throws(() => phoneStorageObservation({ ...value, ...changes }, { nodeId, nodeGeneration, poolId: "phone.pool", now }), { code: "phone_storage_unavailable" });
  }
});

test('phone generation resolves only current enrolled identity and still fences exact commands',async()=>{
 let record={nodeId,generation:3,lifecycleState:'ready'};
 const router=new ManagedNodeAgentRouter({ localNodeId: nodeId,nodeRepository:{findNode:async()=>record},connectorFactory:async()=>{assert.fail('stale command reached transport');}});
 assert.deepEqual(await router.resolvePhoneNode({nodeId,minimumGeneration:2}),{nodeId,nodeGeneration:3});
 await assert.rejects(router.readPhoneStorage({nodeId,nodeGeneration:2}),{code:'stale_node_generation'});
 for(const patch of [{generation:1},{generation:NaN},{lifecycleState:'offline'},{lifecycleState:'removed'},{nodeId:value.filesystemUUID+'bad'}]){
  record={nodeId,generation:3,lifecycleState:'ready',...patch};
  await assert.rejects(router.resolvePhoneNode({nodeId,minimumGeneration:2}));
 }
});
test("storage reads use the existing authenticated command with no caller supplied target", async () => {
  let sent;
  const client = new ProtectedNodeAgentClient({ nodeId, nodeGeneration, clock: () => now,
    commandSigner: { async sign() { return { keyId: "test-key", nonce: "test-nonce", signature: "test-signature" }; } },
    workerSpecFactory: { async buildStartPayload() { throw Error("must not start workers"); } },
    transport: { async postCommand(input) {
      sent = input; const command = JSON.parse(input.body);
      return { commandId: command.commandId, nodeId, nodeGeneration, fencingToken: 1, status: "succeeded", payload: value };
    } },
  });
  assert.deepEqual(await client.readPhoneStorage({ correlationId: "phone-storage-test" }), value);
  assert.equal(JSON.parse(sent.body).type, "android-phone.storage");
  assert.deepEqual(JSON.parse(sent.body).payload, {});
  assert.equal(sent.timeoutMilliseconds, 5000); assert.equal(sent.maximumResponseBytes, 4096);
  assert.equal(sent.headers["x-teamaibox-signature"], "test-signature");
});
