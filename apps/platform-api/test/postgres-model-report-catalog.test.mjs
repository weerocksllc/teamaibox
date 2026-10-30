import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelReportCatalog } from "../src/models/postgres-model-report-catalog.mjs";

const profileId = "00000000-0000-4000-8000-000000007921";
const profileKey = "llm.spark.nvfp4.v1";
const fingerprint = Buffer.from("a".repeat(64), "hex");
const comparisonDigest = `sha256:${"b".repeat(64)}`;

function database() {
  return {
    async query(sql, parameters) {
      if (sql.includes("model_profile_registrations")) return { rows: [{
        profile_document: { profileId, profileKey, precision: "nvfp4" },
        profile_fingerprint: fingerprint,
      }] };
      if (sql.includes("FROM compute.model_profiles")) return { rows: [{
        certification_state: "certified", lifecycle_revision: "3",
        lifecycle_reason_key: "model.lifecycle.validation_passed",
        lifecycle_evidence_refs: ["object://validation/final"],
        lifecycle_validation_run_id: "00000000-0000-4000-8000-000000007922",
        lifecycle_updated_at: "2026-08-11T06:00:00.000Z",
      }] };
      if (sql.includes("stage.stage = 'benchmark'")) return { rows: [{ stage_result: {
        evidence: [{
          kind: "benchmark.comparison", digest: comparisonDigest,
          reference: "object://validation/comparison", mediaType: "application/json", sizeBytes: 1024,
        }],
      } }] };
      assert.equal(parameters[0], profileKey);
      return { rows: [
        {
          run_id: "00000000-0000-4000-8000-000000007922", run_state: "certified",
          plan: { profile: { profileKey } }, run_created_at: "2026-08-11T05:00:00.000Z",
          run_updated_at: "2026-08-11T06:00:00.000Z", ordinal: 0,
          stage: "discovery", stage_state: "passed",
          stage_result: { environmentDigest: `sha256:${"c".repeat(64)}`, evidence: [] },
        },
        {
          run_id: "00000000-0000-4000-8000-000000007922", run_state: "certified",
          plan: { profile: { profileKey } }, run_created_at: "2026-08-11T05:00:00.000Z",
          run_updated_at: "2026-08-11T06:00:00.000Z", ordinal: 1,
          stage: "benchmark", stage_state: "passed",
          stage_result: { environmentDigest: `sha256:${"c".repeat(64)}`, evidence: [] },
        },
      ] };
    },
  };
}

test("PostgreSQL model report catalog joins immutable profile, lifecycle, and validation evidence", async () => {
  const readCalls = [];
  const catalog = new PostgresModelReportCatalog({
    database: database(),
    evidenceReader: {
      async readJson(input) {
        readCalls.push(input);
        return {
          comparisonKind: "nvfp4-versus-bf16-identical-workload", outcome: "passed",
          candidate: { profileKey }, reference: { profileKey: "llm.spark.bf16.v1" },
          rawEvidenceRefs: ["evidence://comparison/summary"],
        };
      },
    },
  });
  assert.equal((await catalog.getProfile(profileKey)).fingerprint, `sha256:${"a".repeat(64)}`);
  assert.equal((await catalog.getLifecycle(profileId)).state, "certified");
  const runs = await catalog.listValidationRuns(profileKey);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].environmentDigest, `sha256:${"c".repeat(64)}`);
  assert.deepEqual(runs[0].stages.map((stage) => stage.stage), ["discovery", "benchmark"]);
  const comparisons = await catalog.listComparisons(profileKey);
  assert.equal(comparisons.length, 1);
  assert.deepEqual(comparisons[0].rawEvidenceRefs, [
    "evidence://comparison/summary", "object://validation/comparison",
  ]);
  assert.ok(Number.isSafeInteger(readCalls[0].maximumBytes)&&readCalls[0].maximumBytes>0);
  assert.equal(readCalls[0].digest, comparisonDigest);
});

test("comparison reports fail closed when protected evidence reading is not configured", async () => {
  const catalog = new PostgresModelReportCatalog({ database: database() });
  assert.deepEqual(await catalog.listComparisons(profileKey), []);
  assert.throws(() => new PostgresModelReportCatalog({ database: {} }), /database adapter/);
  assert.throws(() => new PostgresModelReportCatalog({ database: database(), evidenceReader: {} }), /evidence reader/);
});

test('all comparison evidence is included beyond 64, without concurrent object buffering',async()=>{
  let active=0,count=0;
  const evidence=Array.from({length:70},(_,i)=>({kind:'benchmark.comparison',reference:'object://comparison/'+i,digest:'sha256:'+i.toString(16).padStart(64,'0')}));
  const catalog=new PostgresModelReportCatalog({database:{async query(sql){assert.doesNotMatch(sql,/LIMIT 64/);return {rows:evidence.map(v=>({stage_result:{evidence:[v]}}))};}},evidenceReader:{async readJson(){active++;assert.equal(active,1);await new Promise(r=>setImmediate(r));active--;count++;return {comparisonKind:'comparison',outcome:'passed',candidate:{profileKey}};}}});
  assert.equal((await catalog.listComparisons(profileKey)).length,70);assert.equal(count,70);
});
