import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { createAgentBridgeRouteProxy } from "../src/agent-bridge-route-proxy.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("proxies only the bounded authenticated Agent Bridge HTTP and SSE surface", async (context) => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (request.url === "/v1/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: {\"type\":\"server.connected\"}\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      }
    });
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = createAgentBridgeRouteProxy({ upstreamOrigin });
  const proxyOrigin = await listen(proxy);
  context.after(() => { proxy.close(); upstream.close(); });

  const posted = await fetch(proxyOrigin + "/v1/sessions", {
    method: "POST", headers: { authorization: `Bearer ${"a".repeat(48)}`, "content-type": "application/json" }, body: JSON.stringify({ title: "safe" }),
  });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { ok: true });
  const streamed = await fetch(proxyOrigin + "/v1/events", { headers: { authorization: `Bearer ${"a".repeat(48)}` } });
  assert.equal(await streamed.text(), "data: {\"type\":\"server.connected\"}\n\n");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].authorization, `Bearer ${"a".repeat(48)}`);
  assert.equal(seen[0].body, '{"title":"safe"}');
  assert.equal((await fetch(proxyOrigin + "/private")).status, 404);
  assert.equal((await fetch(proxyOrigin + "/v1/sessions", { method: "PUT" })).status, 404);
});

test("fails closed on public, credentialed, or path-bearing upstream origins", () => {
  for (const value of ["https://bridge.internal", "http://user:pass@bridge/", "http://bridge/path"]) {
    assert.throws(() => createAgentBridgeRouteProxy({ upstreamOrigin: value }));
  }
});
