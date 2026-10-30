import assert from "node:assert/strict";
import test from "node:test";

import { createRotatingModelCredentialProxy } from "../src/rotating-model-credential-proxy.mjs";

async function start(options) {
  const server = createRotatingModelCredentialProxy(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}

test("reads a fresh short-lived credential for every allowed model request", async (t) => {
  const tokens = ["first-" + "a".repeat(48), "second-" + "b".repeat(48)];
  const observed = [];
  const { server, origin } = await start({
    credentialProvider: async () => tokens.shift(),
    fetchImplementation: async (url, options) => {
      observed.push({ url: String(url), authorization: options.headers.authorization, body: await new Response(options.body).text() });
      return new Response("data: done\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  t.after(() => server.close());
  for (const model of ["agent.default", "agent.default"]) {
    const response = await fetch(origin + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-must-not-pass" },
      body: JSON.stringify({ model, stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: done\n\n");
  }
  assert.deepEqual(observed.map((item) => item.url), [
    "http://compute-gateway:8080/v1/chat/completions",
    "http://compute-gateway:8080/v1/chat/completions",
  ]);
  assert.deepEqual(observed.map((item) => item.authorization), [
    "Bearer first-" + "a".repeat(48),
    "Bearer second-" + "b".repeat(48),
  ]);
  assert.ok(observed.every((item) => JSON.parse(item.body).model === "agent.default"));
});

test("fails closed for unsupported routes and unavailable credentials before forwarding any body", async (t) => {
  let forwarded = 0;
  const { server, origin } = await start({
    credentialProvider: async () => { throw new Error("unavailable"); },
    fetchImplementation: async () => { forwarded += 1; return new Response(); },
  });
  t.after(() => server.close());
  assert.equal((await fetch(origin + "/healthz")).status, 200);
  assert.equal((await fetch(origin + "/v1/models")).status, 404);
  assert.equal((await fetch(origin + "/v1/chat/completions?outside=1", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await fetch(origin + "/v1/chat/completions", {
    method: "POST", body: "x".repeat(4 * 1024 * 1024 + 1),
  })).status, 503);
  assert.equal((await fetch(origin + "/v1/responses", { method: "POST", body: "{}" })).status, 503);
  assert.equal(forwarded, 0);
});

test("rejects public, credential-bearing, and path-bearing upstream origins", () => {
  for (const value of ["https://compute-gateway:8080", "http://user:pass@compute-gateway:8080", "http://compute-gateway:8080/v1"]) {
    assert.throws(() => createRotatingModelCredentialProxy({ upstreamOrigin: value }), TypeError);
  }
});
