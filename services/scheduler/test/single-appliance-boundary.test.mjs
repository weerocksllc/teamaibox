import assert from "node:assert/strict";
import test from "node:test";
import { ManagedNodeAgentRouter } from "../src/managed-node-agent-router.mjs";
import { ManagedNodeService } from "../src/managed-node-service.mjs";
import { MemoryManagedNodeRepository } from "../src/memory-managed-node-repository.mjs";
import { PostgresPhoneCapacity } from "../src/postgres-phone-capacity.mjs";
import { PostgresComputerCapacity } from "../src/postgres-computer-capacity.mjs";
import { PostgresAppliancePlacementRepository } from "../src/postgres-appliance-placement-repository.mjs";

const LOCAL = "00000000-0000-4000-8000-000000000020";
const FOREIGN = "00000000-0000-4000-8000-000000000019";
const context = { identityId: LOCAL, permissions: ["node:view", "node:manage"] };
const unavailable = () => assert.fail("must not call a remote connector or query");
const database = { query: unavailable, transaction: unavailable };
const baselineProvider = { read: unavailable };
const phone = { nodeId: LOCAL, nodeGeneration: 1, poolId: "phone-data", imageDigest: `sha256:${"a".repeat(64)}`, maximumPhones: null };
const computer = { nodeId: LOCAL, poolId: "computer-data", profileIds: ["windows-11"], policy: {} };

test("worker and phone dispatch reject a foreign target before connecting", async () => {
  const router = new ManagedNodeAgentRouter({ localNodeId: LOCAL,
    nodeRepository: { findNode: unavailable }, connectorFactory: unavailable });
  const authority = { nodeGeneration: 1 };
  await assert.rejects(router.startWorker({ worker: { nodeId: FOREIGN, nodeGeneration: 1 }, authority }), { code: "appliance_node_mismatch" });
  await assert.rejects(router.stopWorker({ nodeId: FOREIGN, authority }), { code: "appliance_node_mismatch" });
  await assert.rejects(router.resolvePhoneNode({ nodeId: FOREIGN, minimumGeneration: 1 }), { code: "appliance_node_mismatch" });
});

test("a mismatched saved node cannot redirect local worker dispatch", async () => {
  const router = new ManagedNodeAgentRouter({ localNodeId: LOCAL, connectorFactory: unavailable,
    nodeRepository: { async findNode() { return { nodeId: FOREIGN, lifecycleState: "ready", generation: 1 }; } } });
  await assert.rejects(router.startWorker({ worker: { nodeId: LOCAL, nodeGeneration: 1 }, authority: { nodeGeneration: 1 } }),
    { code: "managed_node_not_found" });
});

test("guest installation configuration cannot enable additional or replacement boxes", () => {
  for (const approvedNodes of [[{ ...phone, nodeId: FOREIGN }], [phone, { ...phone, nodeId: FOREIGN }], []]) {
    assert.throws(() => new PostgresPhoneCapacity({ database, baselineProvider, localNodeId: LOCAL, approvedNodes }), /single local appliance/);
  }
  for (const installedNodes of [[{ ...computer, nodeId: FOREIGN }], [computer, { ...computer, nodeId: FOREIGN }], []]) {
    assert.throws(() => new PostgresComputerCapacity({ database, baselineProvider, localNodeId: LOCAL, installedNodes }), /single local appliance/);
  }
  assert.ok(new PostgresPhoneCapacity({ database, baselineProvider, localNodeId: LOCAL, approvedNodes: [phone] }));
  assert.ok(new PostgresComputerCapacity({ database, baselineProvider, localNodeId: LOCAL, installedNodes: [computer] }));
});

test("local observation, timeout and administration leave historical foreign records untouched", async () => {
  const repository = new MemoryManagedNodeRepository();
  const now = new Date("2026-10-16T08:00:00Z");
  for (const nodeId of [LOCAL, FOREIGN]) await repository.createNode({
    nodeId, nodeKey: nodeId === LOCAL ? "appliance" : "historical-record", generation: 1, revision: 1,
    lifecycleState: "ready", health: { state: "healthy" }, architecture: "arm64", labels: {},
    createdAt: now, updatedAt: now, lastSeenAt: new Date(now.getTime() - 120_000),
  });
  const foreignBefore = await repository.findNode(FOREIGN);
  const service = new ManagedNodeService({ repository, localNodeId: LOCAL, clock: () => now });
  for (const [method, input] of [["get", {}], ["updateLabels", { nodeLabels: {} }], ["setDrain", { draining: true }], ["setEnabled", { enabled: false }]]) {
    await assert.rejects(service[method]({ context, nodeId: FOREIGN, expectedRevision: 1, ...input }), { code: "appliance_node_mismatch" });
  }
  await assert.rejects(service.heartbeat({ nodeId: FOREIGN }), { code: "appliance_node_mismatch" });
  assert.deepEqual((await service.list({ context })).data.map(node => node.nodeId), [LOCAL]);
  await service.beginObservationWindow();
  await service.reconcileStale({ now });
  assert.deepEqual((await service.reconcileStale({ now: new Date(now.getTime() + 46_000) })).fenced.map(node => node.nodeId), [LOCAL]);
  assert.deepEqual(await repository.findNode(FOREIGN), foreignBefore);
});

test("protected local placement only queries the exact appliance and does not load groups", async () => {
  const queries = [];
  const repository = new PostgresAppliancePlacementRepository({ localNodeId: LOCAL, database: {
    async query(sql, values) { queries.push({ sql, values }); return { rows: [{ id: LOCAL, appliance_role: "appliance-core" }] }; },
  } });
  assert.equal((await repository.listNodePlacements())[0].node.nodeId, LOCAL);
  assert.deepEqual(queries[0].values, [LOCAL]);
  assert.match(queries[0].sql, /WHERE id=\$1 AND appliance_role='appliance-core'/);
  assert.doesNotMatch(queries[0].sql, /node_groups|JOIN/i);
});
