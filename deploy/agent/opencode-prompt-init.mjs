import { randomBytes } from "node:crypto";
import { chown, mkdir, writeFile } from "node:fs/promises";

import {
  agentOpenCodeConfig,
  directAgentComponentProviderOptions,
} from "../services/agent-bridge/src/agent-model-access-service.mjs";

for (const path of [
  "/runtime/secrets",
  "/runtime/xdg-config/opencode",
  "/model-secrets",
  "/workspace/.teamaibox/home",
  "/workspace/.teamaibox/data",
  "/workspace/.teamaibox/cache",
]) await mkdir(path, { recursive: true });

const opencodePassword = randomBytes(48).toString("base64url");
const bridgeToken = randomBytes(48).toString("base64url");
const modelToken = randomBytes(48).toString("base64url");
await writeFile("/runtime/secrets/opencode-password", opencodePassword, { mode: 0o400, flag: "wx" });
await writeFile("/runtime/secrets/agent-bridge-token", bridgeToken, { mode: 0o400, flag: "wx" });
await writeFile("/model-secrets/teamaibox-model-token", modelToken, { mode: 0o400, flag: "wx" });
const config = agentOpenCodeConfig([{
  alias: "agent.default",
  displayName: "Team AI Box NVFP4 Agent",
  contextTokens: 32768,
  outputTokens: 4096,
  approvedForAgent: true,
}], "agent.default", directAgentComponentProviderOptions);
await writeFile("/runtime/xdg-config/opencode/opencode.json", `${JSON.stringify(config)}\n`, { mode: 0o444, flag: "wx" });
await writeFile(
  "/runtime/xdg-config/opencode/.gitignore",
  "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n",
  { mode: 0o444, flag: "wx" },
);
for (const path of [
  "/runtime/secrets/opencode-password",
  "/runtime/secrets/agent-bridge-token",
  "/model-secrets/teamaibox-model-token",
]) await chown(path, 65532, 65532);
await chown("/workspace", 65532, 65532);
for (const path of [
  "/workspace/.teamaibox", "/workspace/.teamaibox/home",
  "/workspace/.teamaibox/data", "/workspace/.teamaibox/cache",
]) await chown(path, 65532, 65532);
