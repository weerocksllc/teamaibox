import assert from "node:assert/strict";
import test from "node:test";
import { loadDiagnosticPages } from "../src/device/diagnostic-pages.mjs";

test("diagnostic client follows every page and preserves unrelated response metadata", async () => {
  const calls = [];
  const result = await loadDiagnosticPages(async (path) => {
    calls.push(path);
    return { generatedAt: "first", data: Array.from({ length: 1000 }, (_, i) => i + (calls.length - 1) * 1000), nextCursor: calls.length < 3 ? `next-${calls.length}` : null };
  }, "/alerts?status=all", ["data"]);
  assert.equal(result.data.length, 3000);
  assert.equal(new Set(result.data).size, 3000);
  assert.equal(result.generatedAt, "first");
  assert.deepEqual(calls, ["/alerts?status=all", "/alerts?status=all&cursor=next-1", "/alerts?status=all&cursor=next-2"]);
});

test("correlation pages combine unequal collections and do not swallow failures", async () => {
  let count = 0;
  const result = await loadDiagnosticPages(async () => ++count === 1
    ? { correlationId: "x", signals: [1], health: [2], alerts: [], nextCursor: "next" }
    : { correlationId: "x", signals: [3], health: [], alerts: [], nextCursor: null }, "/correlation", ["signals", "health", "alerts"]);
  assert.deepEqual(result.signals, [1, 3]); assert.deepEqual(result.health, [2]);
  await assert.rejects(loadDiagnosticPages(async () => ({ data: [], nextCursor: "same" }), "/alerts", ["data"]), /翻页失败/);
  await assert.rejects(loadDiagnosticPages(async () => ({ data: null }), "/alerts", ["data"]), /无效数据/);
  await assert.rejects(loadDiagnosticPages(async () => { throw new Error("offline"); }, "/alerts", ["data"]), /offline/);
});
