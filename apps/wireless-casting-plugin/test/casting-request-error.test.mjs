import assert from "node:assert/strict";
import test from "node:test";
import { fetchCastingJsonV1 } from "../src/public/casting-client-v1.mjs";
test("fetching a failed request preserves structured service error details", async () => {
  const details={component:'receiver'};
  await assert.rejects(fetchCastingJsonV1("/test", {}, { fetchImpl: async () => ({ ok: false, status: 409,
    json: async () => ({ error: { code: "cast_media_runtime_unavailable", message: "unavailable", details } }) }) }), error => {
    assert.deepEqual(error.details, details); return true;
  });
});
