import { createAgentBridgeRouteProxy } from "../src/agent-bridge-route-proxy.mjs";

const port = Number(process.env.AGENT_BRIDGE_PROXY_PORT || "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Agent Bridge proxy port is invalid");
const server = createAgentBridgeRouteProxy({ upstreamOrigin: process.env.AGENT_BRIDGE_UPSTREAM_ORIGIN });
server.listen(port, "0.0.0.0");
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit());
  server.closeAllConnections?.();
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
server.on("error", () => { process.exitCode = 1; });

