import { readFile } from "node:fs/promises";

import { createStructuredLogger } from "../packages/observability/src/index.mjs";
import { createOpenCodeAdapter } from "../services/agent-bridge/src/opencode-adapter-registry.mjs";
import { createOpenCodeBridgeHttpServer } from "../services/agent-bridge/src/opencode-bridge-http-server.mjs";

const OPENCODE_PASSWORD_FILE = "/run/teamaibox/secrets/opencode-password";
const BRIDGE_TOKEN_FILE = "/run/teamaibox/secrets/agent-bridge-token";
const logger = createStructuredLogger({ service: "agent-bridge" });

async function secret(path) {
  const raw = await readFile(path);
  try {
    const value = raw.toString("utf8").trim();
    if (value.length < 32 || value.length > 4096 || /[\s\0]/.test(value)) throw new Error("credential_invalid");
    return value;
  } finally {
    raw.fill(0);
  }
}

const adapter = createOpenCodeAdapter({
  version: "1.18.16",
  artifactDigest: "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
  origin: "http://127.0.0.1:4096",
  credentialProvider: async () => ({ username: "opencode", password: await secret(OPENCODE_PASSWORD_FILE) }),
  // Qwen3.8 may legitimately take longer than 30 seconds after a cold
  // sandbox/model hand-off. Keep this aligned with the Platform-side bridge
  // client so the inner adapter does not cancel a healthy model request first.
  timeoutMs: 120_000,
});
const server = createOpenCodeBridgeHttpServer({
  adapter,
  tokenProvider: () => secret(BRIDGE_TOKEN_FILE),
  workspace: "/workspace",
});

server.listen(4097, "0.0.0.0", () => logger.info("agent_bridge.listening", { host: "0.0.0.0", port: 4097 }));
server.on("clientError", (error, socket) => {
  logger.warn("agent_bridge.client_error", { error });
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", (error) => {
  logger.error("agent_bridge.server_error", { error });
  process.exitCode = 1;
});

let closing = false;
function close(signal) {
  if (closing) return;
  closing = true;
  logger.info("agent_bridge.stopping", { signal });
  server.close(() => process.exit());
  server.closeAllConnections?.();
}
process.once("SIGTERM", () => close("SIGTERM"));
process.once("SIGINT", () => close("SIGINT"));
