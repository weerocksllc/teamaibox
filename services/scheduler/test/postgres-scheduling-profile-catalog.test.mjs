import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSchedulingProfileCatalog } from "../src/postgres-scheduling-profile-catalog.mjs";

test("scheduling profile catalog combines immutable deployment facts with current certification", async () => {
  const calls = [];
  const catalog = new PostgresSchedulingProfileCatalog({ database: { async query(sql, values) {
    calls.push([sql, values]);
    return { rows: [{
      profile_document: { profileId: values[0][0], profileKey: "llm.spark.nvfp4", certification: { state: "experimental" } },
      profile_fingerprint: Buffer.from("a".repeat(64), "hex"),
      certification_state: "certified",
      lifecycle_evidence_refs: ["evidence://soak"],
      placement_class: "protected-resident",
      placement_node_group_id: "00000000-0000-4000-8000-000000000102",
      desired_state_revision: 4,
      observed_state_revision: 3,
      maintenance_generation: 2,
      recovery_state: "recovering",
      recovery_reason_code: "worker_restart",
    }] };
  } } });
  const id = "00000000-0000-4000-8000-000000000101";
  const result = await catalog.findByIds([id]);
  assert.equal(result[0].profile.certification.state, "certified");
  assert.deepEqual(result[0].profile.certification.evidenceRefs, ["evidence://soak"]);
  assert.equal(result[0].profile.placement.placementClass, "protected-resident");
  assert.equal(result[0].profile.placement.maintenanceGeneration, 2);
  assert.equal(result[0].profile.placement.recoveryReasonCode, "worker_restart");
  assert.equal(result[0].fingerprint, `sha256:${"a".repeat(64)}`);
  assert.match(calls[0][0], /model_profile_registrations/);
  assert.match(calls[0][0], /certification_state/);
});
