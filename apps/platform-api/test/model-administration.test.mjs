import assert from "node:assert/strict";
import test from "node:test";

import { createModelAdministration } from "../src/models/model-administration.mjs";

test("model administration composes lifecycle and report APIs over one durable database", () => {
  const database = {
    async query() { return { rows: [] }; },
    async transaction(callback) { return callback({ query: this.query }); },
  };
  const administration = createModelAdministration({ database });
  assert.equal(typeof administration.lifecycleService.listProfiles, "function");
  assert.equal(typeof administration.reportService.generateCard, "function");
  assert.equal(administration.httpApi.matches("GET", "/api/v1/admin/model-profiles"), true);
  assert.equal(administration.httpApi.matches("GET", "/api/v1/admin/model-profiles/by-key/llm.spark.v1/card"), true);
  assert.throws(() => createModelAdministration({ database: {} }), /transactional adapter/);
});
