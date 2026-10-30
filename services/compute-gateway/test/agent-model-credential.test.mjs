import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  AgentComputeCredentialAuthentication,
  AgentModelCredentialAuthority,
} from "../src/agent-model-credential.mjs";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";

async function fixture() {
  const authority = new AgentModelCredentialAuthority({ signingKey: randomBytes(32), clock: () => new Date(NOW) });
  const issued = await authority.issue({
    subject: OWNER,
    sandboxId: SANDBOX,
    audience: "compute.openai",
    scopes: ["openai:chat.completions", "openai:responses"],
    modelAliases: ["agent.large", "agent.default"],
    expiresAt: new Date(NOW.getTime() + 300_000),
    singleSandbox: true,
  });
  return { authority, issued };
}

test("issues a five-minute sandbox-bound credential without exposing the signing key", async () => {
  const { authority, issued } = await fixture();
  assert.match(issued.token, /^taib_agent_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(issued.subject, OWNER);
  assert.equal(issued.sandboxId, SANDBOX);
  assert.deepEqual(issued.scopes, ["openai:chat.completions", "openai:responses"]);
  assert.deepEqual(issued.modelAliases, ["agent.default", "agent.large"]);
  assert.equal(issued.expiresAt.toISOString(), "2026-08-12T10:05:00.000Z");
  const verified = authority.verify({ token: issued.token, method: "POST", pathname: "/v1/chat/completions" });
  assert.equal(verified.tokenId, issued.tokenId);
  assert.equal(verified.subject, OWNER);
  assert.equal(JSON.stringify(verified).includes(issued.token), false);
});

test("rejects tampering, expiry, unsupported routes, and widened issuance", async () => {
  const key = randomBytes(32);
  let now = new Date(NOW);
  const authority = new AgentModelCredentialAuthority({ signingKey: key, clock: () => new Date(now) });
  const issued = await authority.issue({
    subject: OWNER, sandboxId: SANDBOX, audience: "compute.openai",
    scopes: ["openai:chat.completions"], modelAliases: ["agent.default"],
    expiresAt: new Date(NOW.getTime() + 30_000), singleSandbox: true,
  });
  const last = issued.token.at(-1) === "A" ? "B" : "A";
  assert.throws(() => authority.verify({ token: issued.token.slice(0, -1) + last, method: "POST", pathname: "/v1/chat/completions" }), { code: "invalid_credential" });
  assert.throws(() => authority.verify({ token: issued.token, method: "POST", pathname: "/v1/images/generations" }), { code: "invalid_credential" });
  assert.throws(() => authority.verify({ token: issued.token, method: "POST", pathname: "/v1/responses" }), { code: "invalid_credential" });
  now = new Date(NOW.getTime() + 31_000);
  assert.throws(() => authority.verify({ token: issued.token, method: "POST", pathname: "/v1/chat/completions" }), { code: "invalid_credential" });
  await assert.rejects(authority.issue({
    subject: OWNER, sandboxId: SANDBOX, audience: "compute.openai", scopes: ["admin:models"],
    modelAliases: ["agent.default"], expiresAt: new Date(now.getTime() + 30_000), singleSandbox: true,
  }), /scopes are invalid/);
});

test("platform authentication preserves the user while projecting only configured backend aliases", async () => {
  const { authority, issued } = await fixture();
  const authentication = new AgentComputeCredentialAuthentication({
    authority,
    modelAliasMap: new Map([
      ["agent.default", "local/qwen3.6-35b-nvfp4"],
      ["agent.large", "external/large"],
    ]),
  });
  const context = await authentication.authenticate({
    secret: issued.token,
    permission: "ai:invoke",
    resource: { kind: "appliance", key: "*" },
    operation: { method: "POST", pathname: "/v1/chat/completions" },
  });
  assert.equal(context.identityId, OWNER);
  assert.equal(context.identityKind, "agent_sandbox");
  assert.equal(context.sandboxId, SANDBOX);
  assert.deepEqual(context.permissions, ["ai:invoke"]);
  assert.deepEqual(context.modelAliases, ["external/large", "local/qwen3.6-35b-nvfp4"]);
  await assert.rejects(authentication.authenticate({
    secret: issued.token,
    permission: "models:admin",
    resource: { kind: "appliance", key: "*" },
    operation: { method: "POST", pathname: "/v1/chat/completions" },
  }), { code: "invalid_credential" });
});
