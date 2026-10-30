import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";

const TOKEN = "a".repeat(43);
const PATH = `/api/v1/external-object-proxy/${TOKEN}/content`;

async function fixture(api) {
  const server = createPlatformApiServer({
    authentication: { async authenticateSession() { throw new Error("proxy must not ask for a browser session"); } },
    preferences: {}, publicOrigin: "https://box.test", externalObjectProxyApi: api,
    logger: { warn() {} },
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("platform serves an HTTPS-bound external proxy ticket without browser authentication or enumeration", async () => {
  let received = null;
  const api = {
    matches: (method, pathname) => method === "PUT" && pathname === PATH,
    bodyKind: () => "bytes",
    async handle(input) { received = input; return { kind: "json", status: 201, body: { stored: true } }; },
  };
  const app = await fixture(api);
  try {
    const insecure = await fetch(app.origin + PATH, { method: "PUT", body: "data" });
    assert.equal(insecure.status, 426);
    const response = await fetch(app.origin + PATH, {
      method: "PUT", headers: { "x-forwarded-proto": "https", "content-type": "application/octet-stream" }, body: "data",
    });
    assert.equal(response.status, 201);
    assert.deepEqual([...received.body], [...Buffer.from("data")]);
    const list = await fetch(app.origin + "/api/v1/external-object-proxy", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(list.status, 404);
  } finally { await app.close(); }
});
