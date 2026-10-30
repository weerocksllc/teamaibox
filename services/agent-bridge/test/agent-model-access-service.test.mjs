import assert from "node:assert/strict";
import test from "node:test";

import { AgentModelAccessService } from "../src/agent-model-access-service.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";
const TOKEN_ID = "018f6f18-24d7-7c21-9b62-8c017419958c";
const NOW = new Date("2026-08-11T07:00:00.000Z");
const TOKEN = "scoped-agent-token-" + "x".repeat(48);
const SCOPES = ["openai:chat.completions", "openai:responses"];

function fixture({ issuerMutation = (value) => value } = {}) {
  const issues = [];
  const configs = [];
  const secrets = [];
  const audits = [];
  const service = new AgentModelAccessService({
    clock: () => new Date(NOW),
    catalog: {
      async listApprovedAgentModels(ownerIdentityId) {
        assert.equal(ownerIdentityId, OWNER);
        return [
          { alias: "agent.default", displayName: "Team Default", contextTokens: 32768, outputTokens: 8192, approvedForAgent: true },
          { alias: "agent.large", displayName: "Team Large", contextTokens: 131072, outputTokens: 16384, approvedForAgent: true },
        ];
      },
    },
    credentialIssuer: {
      async issue(input) {
        issues.push(structuredClone(input));
        return issuerMutation({
          token: TOKEN,
          tokenId: TOKEN_ID,
          subject: input.subject,
          sandboxId: input.sandboxId,
          audience: input.audience,
          scopes: [...input.scopes],
          modelAliases: [...input.modelAliases],
          expiresAt: new Date(input.expiresAt),
        });
      },
    },
    sandboxProjector: {
      async projectConfig(input) { configs.push({ ...input, contents: Buffer.from(input.contents) }); },
      async projectSecret(input) { secrets.push({ ...input, contents: Buffer.from(input.contents) }); },
    },
    audit: async (event) => { audits.push(event); },
  });
  return { service, issues, configs, secrets, audits };
}

test("projects one rotating short-lived token and an approved-provider-only OpenCode config", async () => {
  const { service, issues, configs, secrets, audits } = fixture();
  const result = await service.provision({
    ownerIdentityId: OWNER,
    sandboxId: SANDBOX,
    requestedAliases: ["agent.large", "agent.default"],
    defaultAlias: "agent.default",
  });
  assert.deepEqual(issues[0].scopes, SCOPES);
  assert.deepEqual(issues[0].modelAliases, ["agent.default", "agent.large"]);
  assert.equal(issues[0].audience, "compute.openai");
  assert.equal(issues[0].singleSandbox, true);
  assert.equal(issues[0].expiresAt.toISOString(), "2026-08-11T07:05:00.000Z");
  assert.equal(secrets[0].target, "/run/secrets/teamaibox-model-token");
  assert.equal(secrets[0].mode, 0o400);
  assert.equal(secrets[0].contents.toString(), TOKEN);
  assert.equal(configs[0].target, "/run/teamaibox/xdg-config/opencode/opencode.json");
  assert.equal(configs[0].mode, 0o444);
  assert.equal(configs[0].ownerUid, 0);
  assert.equal(configs[0].ownerGid, 0);
  const configText = configs[0].contents.toString();
  const config = JSON.parse(configText);
  assert.deepEqual(config.enabled_providers, ["teamaibox"]);
  assert.deepEqual(Object.keys(config.provider), ["teamaibox"]);
  assert.equal(config.provider.teamaibox.npm, "@ai-sdk/openai-compatible");
  assert.equal(config.provider.teamaibox.options.baseURL, "http://127.0.0.1:4095/v1");
  assert.equal(config.provider.teamaibox.options.apiKey, "local-proxy");
  assert.deepEqual(Object.keys(config.provider.teamaibox.models), ["agent.default", "agent.large"]);
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, "disabled");
  assert.equal(config.autoshare, false);
  assert.deepEqual(config.plugin, []);
  assert.equal(config.permission, "ask");
  assert.ok(!configText.includes(TOKEN));
  assert.ok(!configText.includes("/run/secrets/teamaibox-model-token"));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(audits).includes(TOKEN));
  assert.deepEqual(result.defaultModel, { providerId: "teamaibox", modelId: "agent.default" });
});

test("unapproved model aliases fail before credential issuance", async () => {
  const { service, issues, configs, secrets } = fixture();
  await assert.rejects(service.provision({
    ownerIdentityId: OWNER,
    sandboxId: SANDBOX,
    requestedAliases: ["public.openai"],
    defaultAlias: "public.openai",
  }), { code: "agent_model_not_approved" });
  assert.equal(issues.length, 0);
  assert.equal(configs.length, 0);
  assert.equal(secrets.length, 0);
});

test("rejects provider routes outside the closed local-proxy and component-fixture set", () => {
  assert.throws(() => new AgentModelAccessService({
    catalog: { listApprovedAgentModels: async () => [] },
    credentialIssuer: { issue: async () => null },
    sandboxProjector: { projectConfig: async () => {}, projectSecret: async () => {} },
    openCodeProviderOptions: { apiKey: "outside", baseURL: "https://api.example.com/v1" },
  }), { code: "agent_model_provider_invalid" });
});

test("issuer cannot widen scope, audience, sandbox, aliases, or lifetime", async () => {
  for (const mutation of [
    (value) => ({ ...value, scopes: [...value.scopes, "admin:models"] }),
    (value) => ({ ...value, audience: "public.openai" }),
    (value) => ({ ...value, sandboxId: "018f6f18-24d7-7c21-9b62-8c0174199599" }),
    (value) => ({ ...value, modelAliases: ["agent.default", "unapproved"] }),
    (value) => ({ ...value, expiresAt: new Date(NOW.getTime() + 301_000) }),
  ]) {
    const { service, configs, secrets } = fixture({ issuerMutation: mutation });
    await assert.rejects(service.provision({
      ownerIdentityId: OWNER,
      sandboxId: SANDBOX,
      requestedAliases: ["agent.default"],
      defaultAlias: "agent.default",
    }), { code: "agent_model_credential_invalid" });
    assert.equal(configs.length, 0);
    assert.equal(secrets.length, 0);
  }
});
