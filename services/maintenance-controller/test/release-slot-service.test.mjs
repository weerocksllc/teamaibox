import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseSlotService } from "../src/release-slot-service.mjs";

const NODE = "00000000-0000-4000-8000-000000000091", PLAN = "00000000-0000-4000-8000-000000000092";
const FAILURE_PLAN = "00000000-0000-4000-8000-000000000093";
const baseline = { version: "2026.8.20", digest: `sha256:${"1".repeat(64)}`, postCheckPass: true };
const good = { version: "2026.8.21", digest: `sha256:${"2".repeat(64)}`, postCheckPass: true };
const bad = { version: "2026.8.22", digest: `sha256:${"3".repeat(64)}`, postCheckPass: false };

test("stages, applies, verifies, persists, and rolls back exact release slots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamaibox-maintenance-"));
  try {
    let service = new ReleaseSlotService({ nodeId: NODE, root, candidates: [good, bad], baseline }); await service.initialize();
    const input = { nodeId: NODE, planId: PLAN, candidateDigest: good.digest };
    assert.equal((await service.stage(input)).passed, true); assert.equal((await service.apply(input)).passed, true); assert.equal((await service.postcheck(input)).passed, true);
    service = new ReleaseSlotService({ nodeId: NODE, root, candidates: [good, bad], baseline }); await service.initialize();
    assert.equal((await service.status()).active.digest, good.digest); assert.equal((await service.rollback(input)).passed, true); assert.equal((await service.status()).active.digest, baseline.digest);
  } finally { await rm(root, { recursive: true }); }
});

test("failed post-check restores the exact prior slot and its plan provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamaibox-maintenance-"));
  try {
    const service = new ReleaseSlotService({ nodeId: NODE, root, candidates: [good, bad], baseline }); await service.initialize();
    const healthyInput = { nodeId: NODE, planId: PLAN, candidateDigest: good.digest };
    await service.stage(healthyInput); await service.apply(healthyInput); assert.equal((await service.postcheck(healthyInput)).passed, true);
    const failedInput = { nodeId: NODE, planId: FAILURE_PLAN, candidateDigest: bad.digest };
    await service.stage(failedInput); await service.apply(failedInput); assert.equal((await service.postcheck(failedInput)).passed, false); await service.rollback(failedInput);
    const state = await service.status();
    assert.equal(state.active.digest, good.digest); assert.equal(state.appliedPlanId, PLAN); assert.equal(state.previous, null); assert.equal(state.previousPlanId, null);
  } finally { await rm(root, { recursive: true }); }
});

test("only one exact release can be staged at a time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamaibox-maintenance-"));
  try {
    const service = new ReleaseSlotService({ nodeId: NODE, root, candidates: [good, bad], baseline }); await service.initialize();
    await service.stage({ nodeId: NODE, planId: PLAN, candidateDigest: good.digest });
    await assert.rejects(service.stage({ nodeId: NODE, planId: FAILURE_PLAN, candidateDigest: bad.digest }), (error) => error.code === "update_release_conflict");
  } finally { await rm(root, { recursive: true }); }
});
