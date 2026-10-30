import assert from "node:assert/strict";
import test from "node:test";

import { NodeAgentSandboxProjector } from "../src/node-agent-sandbox-projector.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const OTHER = "018f6f18-24d7-7c21-9b62-8c0174199589";
const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";
const WORKER = "018f6f18-24d7-7c21-9b62-8c017419958c";
const NODE = "018f6f18-24d7-7c21-9b62-8c017419958d";
const TOKEN_ID = "018f6f18-24d7-7c21-9b62-8c017419958e";
const NOW = new Date("2026-08-11T07:00:00.000Z");

function fixture(state = "running") {
  const calls = [];
  const audits = [];
  const sandbox = {
    id: SANDBOX, ownerIdentityId: OWNER, workerId: WORKER, nodeId: NODE,
    containerId: state === "running" ? "container-agent" : null,
    sandboxKey: "sandbox." + "a".repeat(32), generation: 3, state,
  };
  const projector = new NodeAgentSandboxProjector({
    clock: () => new Date(NOW),
    repository: { async findSandbox(id) { assert.equal(id, SANDBOX); return structuredClone(sandbox); } },
    nodeAgent: {
      async projectSandboxFile(command) {
        calls.push(structuredClone(command));
        return { workerId: command.workerId, fileClass: command.fileClass, contentSha256: command.contentSha256, bytes: Buffer.from(command.contentBase64, "base64").length };
      },
    },
    audit: async (event) => audits.push(structuredClone(event)),
  });
  return { projector, calls, audits };
}

test("projects an ephemeral model token through the owned running Node Agent sandbox", async () => {
  const { projector, calls, audits } = fixture();
  const token = Buffer.from("scoped-agent-token-" + "x".repeat(48));
  const result = await projector.projectSecret({
    sandboxId: SANDBOX, ownerIdentityId: OWNER, tokenId: TOKEN_ID,
    target: "/run/secrets/teamaibox-model-token", contents: token,
    mode: 0o400, ownerUid: 65532, ownerGid: 65532,
    expiresAt: new Date(NOW.getTime() + 300_000), ephemeralMountRequired: true,
  });
  assert.equal(result.fileClass, "model-token");
  assert.equal(Buffer.from(calls[0].contentBase64, "base64").toString(), token.toString());
  assert.deepEqual(calls[0].sensitiveFields, ["contentBase64"]);
  assert.equal(calls[0].ownerIdentityId, OWNER);
  assert.equal(calls[0].generation, 3);
  assert.ok(!JSON.stringify(audits).includes(token.toString()));
  assert.ok(!JSON.stringify(result).includes(token.toString()));
});

test("rejects cross-user and stopped-sandbox projections before the Node Agent", async () => {
  const token = Buffer.from("scoped-agent-token-" + "x".repeat(48));
  const crossUser = fixture();
  await assert.rejects(crossUser.projector.projectSecret({
    sandboxId: SANDBOX, ownerIdentityId: OTHER, tokenId: TOKEN_ID,
    target: "/run/secrets/teamaibox-model-token", contents: token,
    mode: 0o400, ownerUid: 65532, ownerGid: 65532,
    expiresAt: new Date(NOW.getTime() + 300_000), ephemeralMountRequired: true,
  }), { code: "agent_sandbox_projection_owner_denied" });
  assert.equal(crossUser.calls.length, 0);
  const stopped = fixture("stopped");
  await assert.rejects(stopped.projector.projectConfig({
    sandboxId: SANDBOX, ownerIdentityId: OWNER,
    target: "/run/teamaibox/xdg-config/opencode/opencode.json",
    contents: Buffer.from("{}"), mode: 0o444, ownerUid: 0, ownerGid: 0,
    immutableProviderSet: true,
  }), { code: "agent_sandbox_projection_unavailable" });
  assert.equal(stopped.calls.length, 0);
});

test("rejects a user-owned or workspace-persistent OpenCode configuration", async () => {
  const { projector, calls } = fixture();
  await assert.rejects(projector.projectConfig({
    sandboxId: SANDBOX, ownerIdentityId: OWNER,
    target: "/workspace/.teamaibox/config/opencode/opencode.json",
    contents: Buffer.from("{}"), mode: 0o600, ownerUid: 65532, ownerGid: 65532,
    immutableProviderSet: true,
  }), { code: "agent_sandbox_config_projection_denied" });
  assert.equal(calls.length, 0);
});
