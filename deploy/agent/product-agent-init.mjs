import { createHash, randomBytes } from "node:crypto";
import { chown, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { loadAgentIdentities } from "./product-agent-identities.mjs";

import { createPostgresDatabaseFromEnvironment } from "/opt/teamaibox/packages/persistence/src/postgres-database.mjs";
import { PostgresIdentityRepository } from "/opt/teamaibox/apps/platform-api/src/identity/postgres-repository.mjs";
import { AgentModelAccessService } from "/opt/teamaibox/services/agent-bridge/src/agent-model-access-service.mjs";
import {
  generateSourceClientConfig,
  INTERNAL_SOURCE_GATEWAYS,
} from "/opt/teamaibox/services/agent-bridge/src/source-client-config.mjs";
import {
  AgentModelCredentialAuthority,
  loadAgentModelSigningKey,
} from "/opt/teamaibox/services/compute-gateway/src/agent-model-credential.mjs";

// Supply a read-only, owner-only JSON mapping file in this execution environment.
// There are intentionally no default accounts or deployment aliases.
const definitions = await loadAgentIdentities(process.env.TEAMAIBOX_AGENT_IDENTITIES_FILE);

function sandboxId(ownerIdentityId) {
  const hex = createHash("sha256").update(`sandbox\n${ownerIdentityId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sandboxKey(ownerIdentityId) {
  return `sandbox.${createHash("sha256").update(ownerIdentityId).digest("hex").slice(0, 32)}`;
}

async function atomic(filename, contents, { mode, uid, gid }) {
  const temporary = `${filename}.next`;
  await writeFile(temporary, contents, { mode });
  await chown(temporary, uid, gid);
  await chmod(temporary, mode);
  await rename(temporary, filename);
}

const signingKey = await loadAgentModelSigningKey("/agent-trust/agent-model-signing-key");
let authority;
try { authority = new AgentModelCredentialAuthority({ signingKey }); }
finally { signingKey.fill(0); }
const database = await createPostgresDatabaseFromEnvironment(process.env);
let stopping = false;
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

try {
  const repository = new PostgresIdentityRepository({ database });
  await chown("/agent-validation", 65532, 65532);
  await chmod("/agent-validation", 0o700);
  await chown("/agent-source-cache", 65532, 65532);
  await chmod("/agent-source-cache", 0o700);
  const identities = [];
  for (const definition of definitions) {
    const identity = await repository.findByNormalizedLogin(definition.loginName);
    if (!identity) throw new Error("agent_identity_unavailable");
    identities.push({ ...definition, ownerIdentityId: identity.id, sandboxId: sandboxId(identity.id), sandboxKey: sandboxKey(identity.id) });
  }
  for (const value of identities) {
    for (const path of [
      `/agent-${value.key}-runtime/secrets`,
      `/agent-${value.key}-runtime/xdg-config/opencode`,
      `/agent-${value.key}-runtime/source-config/apt`,
      `/agent-${value.key}-model`,
      `/agent-${value.key}-workspace/.teamaibox/home`,
      `/agent-${value.key}-workspace/.teamaibox/data`,
      `/agent-${value.key}-workspace/.teamaibox/cache`,
    ]) await mkdir(path, { recursive: true });
    const sourceConfig = generateSourceClientConfig(INTERNAL_SOURCE_GATEWAYS);
    for (const [relativePath, contents] of [
      ["source-config/pip.conf", sourceConfig.pipConf],
      ["source-config/npmrc", sourceConfig.npmrc],
      ["source-config/apt/apt.conf", sourceConfig.aptConf],
      ["source-config/apt/sources.list", sourceConfig.aptSources],
    ]) {
      await atomic(`/agent-${value.key}-runtime/${relativePath}`, contents, { mode: 0o444, uid: 0, gid: 0 });
    }
    await atomic(
      `/agent-${value.key}-runtime/xdg-config/opencode/.gitignore`,
      "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n",
      { mode: 0o444, uid: 0, gid: 0 },
    );
    for (const [name, token] of [
      ["opencode-password", randomBytes(48).toString("base64url")],
      ["agent-bridge-token", randomBytes(48).toString("base64url")],
    ]) {
      const filename = `/agent-${value.key}-runtime/secrets/${name}`;
      try { await writeFile(filename, token, { mode: 0o400, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      await chown(filename, 65532, 65532);
      await chmod(filename, 0o400);
    }
    const bridgeToken = await readFile(`/agent-${value.key}-runtime/secrets/agent-bridge-token`);
    try {
      await atomic(`/agent-control/${value.key}-agent-bridge-token`, bridgeToken, {
        mode: 0o400, uid: 1000, gid: 1000,
      });
    } finally {
      bridgeToken.fill(0);
    }
    for (const path of [
      `/agent-${value.key}-workspace`,
      `/agent-${value.key}-workspace/.teamaibox`,
      `/agent-${value.key}-workspace/.teamaibox/home`,
      `/agent-${value.key}-workspace/.teamaibox/data`,
      `/agent-${value.key}-workspace/.teamaibox/cache`,
    ]) await chown(path, 65532, 65532);
  }
  const routes = {
    schemaVersion: 1,
    routes: identities.map((value) => ({
      ownerIdentityId: value.ownerIdentityId,
      sandboxKey: value.sandboxKey,
      origin: value.proxyOrigin,
      tokenFile: `/agent-control/${value.key}-agent-bridge-token`,
    })),
  };
  await atomic("/agent-control/routes.json", JSON.stringify(routes, null, 2) + "\n", { mode: 0o444, uid: 1000, gid: 1000 });

  async function refresh() {
    for (const value of identities) {
      const service = new AgentModelAccessService({
        catalog: { async listApprovedAgentModels() { return [{ alias: "agent.default", displayName: "Team AI Box NVFP4 Agent", contextTokens: 32768, outputTokens: 4096, approvedForAgent: true }]; } },
        credentialIssuer: authority,
        sandboxProjector: {
          async projectConfig(input) {
            await atomic(`/agent-${value.key}-runtime/xdg-config/opencode/opencode.json`, input.contents, { mode: 0o444, uid: 0, gid: 0 });
          },
          async projectSecret(input) {
            await atomic(`/agent-${value.key}-model/teamaibox-model-token`, input.contents, { mode: 0o400, uid: 65532, gid: 65532 });
          },
        },
      });
      await service.provision({ ownerIdentityId: value.ownerIdentityId, sandboxId: value.sandboxId, requestedAliases: ["agent.default"], defaultAlias: "agent.default", ttlSeconds: 300 });
    }
  }
  await refresh();
  await writeFile("/agent-control/ready", "ready\n", { mode: 0o444 });
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: "passed", identityCount: identities.length, credentialTtlSeconds: 300, refreshSeconds: 180, credentialsRetained: false }) + "\n");
  if (process.env.TEAMAIBOX_AGENT_REFRESH === "1") {
    while (!stopping) {
      for (let elapsed = 0; elapsed < 180 && !stopping; elapsed += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!stopping) await refresh();
    }
  }
} finally {
  authority.close();
  await database.close();
}
