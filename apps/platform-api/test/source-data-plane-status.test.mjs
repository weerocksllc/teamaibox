import assert from "node:assert/strict";
import test from "node:test";

import { SourceDataPlaneStatusProvider } from "../src/sources/source-data-plane-status.mjs";

test("source data-plane status reports only validated live gateway counters", async () => {
  const provider = new SourceDataPlaneStatusProvider({ gatewayOrigin: "http://source-gateway:8080", clock: () => new Date("2026-08-21T08:00:00Z"), fetchImplementation: async () => new Response(JSON.stringify({ status: "ready", stats: {
    pip: { requests: 9, cacheHits: 6, upstreamFetches: 3, upstreamBytes: 100 }, npm: { requests: 8, cacheHits: 5, upstreamFetches: 3, upstreamBytes: 200 }, apt: { requests: 7, cacheHits: 4, upstreamFetches: 3, upstreamBytes: 300 },
  } }), { status: 200, headers: { "content-type": "application/json" } }) });
  const result = await provider.getStatus();
  assert.equal(result.state, "ready"); assert.equal(result.ecosystems.pip.cacheHits, 6); assert.equal(result.observedAt, "2026-08-21T08:00:00.000Z");
});

test("source data-plane status exposes invalid counters as unavailable instead of zero", async () => {
  const provider = new SourceDataPlaneStatusProvider({ gatewayOrigin: "http://source-gateway:8080", fetchImplementation: async () => new Response('{"status":"ready","stats":{}}', { status: 200 }) });
  const result = await provider.getStatus();
  assert.equal(result.state, "unavailable"); assert.equal(result.errorCode, "source_gateway_health_invalid"); assert.equal(result.ecosystems.apt.requests, null);
  assert.throws(() => new SourceDataPlaneStatusProvider({ gatewayOrigin: "https://user:secret@example.test" }));
});
