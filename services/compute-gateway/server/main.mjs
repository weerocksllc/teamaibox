import { pathToFileURL } from "node:url";

import { createAgentComputeGatewayServer } from "../src/agent-compute-gateway-server.mjs";
import {
  AgentModelCredentialAuthority,
  loadAgentModelAliasMap,
  loadAgentModelSigningKey,
} from "../src/agent-model-credential.mjs";

export async function startAgentComputeGateway(environment = process.env, dependencies = {}) {
  const host = environment.AGENT_COMPUTE_GATEWAY_HOST || "0.0.0.0";
  const port = Number(environment.AGENT_COMPUTE_GATEWAY_PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("AGENT_COMPUTE_GATEWAY_PORT is invalid");
  if (!environment.PLATFORM_COMPUTE_ORIGIN) throw new TypeError("PLATFORM_COMPUTE_ORIGIN is required");
  let authority = dependencies.credentialAuthority ?? null;
  let ownsAuthority = false;
  if (!authority) {
    const key = await loadAgentModelSigningKey(environment.AGENT_MODEL_SIGNING_KEY_FILE);
    try { authority = new AgentModelCredentialAuthority({ signingKey: key }); }
    finally { key.fill(0); }
    ownsAuthority = true;
  }
  try {
    const server = createAgentComputeGatewayServer({
      credentialAuthority: authority,
      modelAliasMap: dependencies.modelAliasMap ?? await loadAgentModelAliasMap(environment.AGENT_MODEL_ALIAS_MAP_FILE),
      platformOrigin: environment.PLATFORM_COMPUTE_ORIGIN,
      fetchImplementation: dependencies.fetchImplementation ?? globalThis.fetch,
    });
    if (ownsAuthority) server.once("close", () => authority.close());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    } catch (error) {
      if (ownsAuthority) authority.close();
      throw error;
    }
    return server;
  } catch (error) {
    if (ownsAuthority) authority.close();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  startAgentComputeGateway().then((server) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ event: "agent_compute_gateway.start_failed", message: error?.message ?? "unknown" }) + "\n");
    process.exitCode = 1;
  });
}
