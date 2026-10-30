import { createStructuredLogger } from "/opt/teamaibox/packages/observability/src/index.mjs";
import {
  createPackageProxyServer,
  packageProxyContract,
} from "/opt/teamaibox/services/source-gateway/src/package-proxy-runtime.mjs";

const logger = createStructuredLogger({ service: "source-gateway" });
const server = createPackageProxyServer({ cacheRoot: "/var/lib/teamaibox-source-cache" });

server.listen(packageProxyContract.listenPort, packageProxyContract.listenHost, () => {
  logger.info("source_gateway.listening", {
    host: packageProxyContract.listenHost,
    port: packageProxyContract.listenPort,
    upstreamCount: Object.keys(packageProxyContract.upstreams).length,
  });
});
server.on("clientError", (error, socket) => {
  logger.warn("source_gateway.client_error", { error });
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", (error) => {
  logger.error("source_gateway.server_error", { error });
  process.exitCode = 1;
});

let closing = false;
function close(signal) {
  if (closing) return;
  closing = true;
  logger.info("source_gateway.stopping", { signal });
  server.close(() => process.exit());
  server.closeAllConnections?.();
}
process.once("SIGTERM", () => close("SIGTERM"));
process.once("SIGINT", () => close("SIGINT"));
