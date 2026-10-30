import { randomBytes } from "node:crypto";
import { chown, mkdir, writeFile } from "node:fs/promises";

import { AgentModelAccessService } from "../services/agent-bridge/src/agent-model-access-service.mjs";
import { directAgentComponentProviderOptions } from "../services/agent-bridge/src/agent-model-access-service.mjs";
import {
  AgentModelCredentialAuthority,
  loadAgentModelSigningKey,
} from "../services/compute-gateway/src/agent-model-credential.mjs";

const ownerIdentityId = process.env.TEAMAIBOX_AGENT_OWNER_ID;
const sandboxId = process.env.TEAMAIBOX_AGENT_SANDBOX_ID;
const signingKey = await loadAgentModelSigningKey("/agent-trust/agent-model-signing-key");
let authority;
try { authority = new AgentModelCredentialAuthority({ signingKey }); }
finally { signingKey.fill(0); }

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
await writeFile("/runtime/secrets/opencode-password", opencodePassword, { mode: 0o400, flag: "wx" });
await writeFile("/runtime/secrets/agent-bridge-token", bridgeToken, { mode: 0o400, flag: "wx" });

const service = new AgentModelAccessService({
  openCodeProviderOptions: directAgentComponentProviderOptions,
  catalog: {
    async listApprovedAgentModels() {
      return [{
        alias: "agent.default",
        displayName: "Team AI Box NVFP4 Agent",
        contextTokens: 32768,
        outputTokens: 4096,
        approvedForAgent: true,
      }];
    },
  },
  credentialIssuer: authority,
  sandboxProjector: {
    async projectConfig(input) {
      if (input.target !== "/run/teamaibox/xdg-config/opencode/opencode.json") throw new Error("config_target_denied");
      await writeFile("/runtime/xdg-config/opencode/opencode.json", input.contents, { mode: input.mode, flag: "wx" });
    },
    async projectSecret(input) {
      if (input.target !== "/run/secrets/teamaibox-model-token") throw new Error("secret_target_denied");
      await writeFile("/model-secrets/teamaibox-model-token", input.contents, { mode: input.mode, flag: "wx" });
      await chown("/model-secrets/teamaibox-model-token", input.ownerUid, input.ownerGid);
    },
  },
});

try {
  const provisioned = await service.provision({
    ownerIdentityId,
    sandboxId,
    requestedAliases: ["agent.default"],
    defaultAlias: "agent.default",
    ttlSeconds: 300,
  });
  await writeFile(
    "/runtime/xdg-config/opencode/.gitignore",
    "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n",
    { mode: 0o444, flag: "wx" },
  );
  for (const path of [
    "/runtime/secrets/opencode-password",
    "/runtime/secrets/agent-bridge-token",
  ]) await chown(path, 65532, 65532);
  await chown("/workspace", 65532, 65532);
  for (const path of [
    "/workspace/.teamaibox", "/workspace/.teamaibox/home",
    "/workspace/.teamaibox/data", "/workspace/.teamaibox/cache",
  ]) await chown(path, 65532, 65532);
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    ownerIdentityId,
    sandboxId,
    tokenId: provisioned.tokenId,
    modelAliases: provisioned.modelAliases,
    expiresAt: provisioned.expiresAt,
    credentialRetainedInOutput: false,
  }) + "\n");
} finally {
  authority.close();
}
