import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import {
  createRotatingModelCredentialProxy,
  rotatingModelCredentialProxyContract,
} from "/opt/teamaibox/services/agent-bridge/src/rotating-model-credential-proxy.mjs";

const passwordBytes = await readFile("/run/teamaibox/secrets/opencode-password");
let password;
try {
  password = passwordBytes.toString("utf8").trim();
  if (password.length < 32 || password.length > 4096 || /[\s\0]/.test(password)) throw new Error("opencode_password_invalid");
} finally {
  passwordBytes.fill(0);
}

const common = { stdio: "inherit", env: { ...process.env } };
const modelProxy = createRotatingModelCredentialProxy();
modelProxy.listen(rotatingModelCredentialProxyContract.listenPort, rotatingModelCredentialProxyContract.listenHost);
await once(modelProxy, "listening");
const opencode = spawn("/opt/opencode/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
  ...common,
  env: { ...common.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" },
});
password = "[REDACTED]";
const bridge = spawn(process.execPath, ["/opt/teamaibox/validation/opencode-bridge-main.mjs"], common);

let stopping = false;
function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  opencode.kill(signal);
  bridge.kill(signal);
  modelProxy.close();
  const timer = setTimeout(() => {
    opencode.kill("SIGKILL");
    bridge.kill("SIGKILL");
    process.exit(exitCode);
  }, 10_000);
  timer.unref();
  Promise.all([
    new Promise((resolve) => opencode.once("exit", resolve)),
    new Promise((resolve) => bridge.once("exit", resolve)),
  ]).finally(() => process.exit(exitCode));
}

opencode.once("error", () => stop("SIGTERM", 1));
bridge.once("error", () => stop("SIGTERM", 1));
modelProxy.once("error", () => stop("SIGTERM", 1));
opencode.once("exit", (code, signal) => {
  if (!stopping) stop("SIGTERM", 1);
});
bridge.once("exit", (code, signal) => {
  if (!stopping) stop("SIGTERM", 1);
});
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
