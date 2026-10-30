import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import { startAgentComputeGateway } from "../server/main.mjs";

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("starts with injected secret-free dependencies and exposes only liveness without credentials", async (t) => {
  const server = await startAgentComputeGateway({
    AGENT_COMPUTE_GATEWAY_HOST: "127.0.0.1",
    AGENT_COMPUTE_GATEWAY_PORT: String(await unusedPort()),
    PLATFORM_COMPUTE_ORIGIN: "http://platform-api.invalid:8080",
  }, {
    credentialAuthority: { verify() { throw new Error("not expected"); } },
    modelAliasMap: new Map([["agent.default", "local/agent"]]),
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "live" });
});

test("fails closed on invalid port and incomplete production configuration", async () => {
  await assert.rejects(startAgentComputeGateway({
    AGENT_COMPUTE_GATEWAY_PORT: "99999", PLATFORM_COMPUTE_ORIGIN: "http://platform.invalid",
  }), /PORT is invalid/);
  await assert.rejects(startAgentComputeGateway({ AGENT_COMPUTE_GATEWAY_PORT: "8080" }), /PLATFORM_COMPUTE_ORIGIN is required/);
});
