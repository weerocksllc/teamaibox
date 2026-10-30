import assert from "node:assert/strict";
import test from "node:test";

import { createPipGatewayServer } from "../gateways/pip/server/pip-gateway-server.mjs";

test("PIP gateway transport resolves trusted sandbox context and serves protocol bytes", async (t) => {
  const contexts = [];
  const server = createPipGatewayServer({
    contextResolver: { resolve: async ({ pathname }) => { contexts.push(pathname); return { architecture: "arm64" }; } },
    api: { matches: (method, path) => method === "GET" && path === "/pip/simple/", handle: async () => ({ status: 200, headers: { "content-type": "application/vnd.pypi.simple.v1+json" }, body: Buffer.from('{"meta":{"api-version":"1.4"},"projects":[]}') }) },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/pip/simple/`, { headers: { accept: "application/vnd.pypi.simple.v1+json" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).meta["api-version"], "1.4");
  assert.deepEqual(contexts, ["/pip/simple/"]);
});
