import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_TARGET = "/run/teamaibox/xdg-config/opencode/opencode.json";
const TOKEN_TARGET = "/run/secrets/teamaibox-model-token";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function byteBuffer(value, maximum) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximum) {
    throw new PlatformError("agent_sandbox_projection_invalid", "Agent sandbox file projection is invalid", { status: 400 });
  }
  return value;
}

function runtimeState(value, expected) {
  if (!value || value.workerId !== expected.workerId || value.fileClass !== expected.fileClass
    || value.contentSha256 !== expected.contentSha256 || value.bytes !== expected.bytes) {
    throw new PlatformError("agent_sandbox_projection_runtime_invalid", "Node Agent returned invalid file projection evidence", { status: 502 });
  }
  return value;
}

export class NodeAgentSandboxProjector {
  #repository;
  #nodeAgent;
  #clock;
  #audit;

  constructor({ repository, nodeAgent, clock = () => new Date(), audit = async () => {} }) {
    if (!repository?.findSandbox || !nodeAgent?.projectSandboxFile || typeof clock !== "function" || typeof audit !== "function") {
      throw new TypeError("Agent sandbox projector dependencies are incomplete");
    }
    this.#repository = repository;
    this.#nodeAgent = nodeAgent;
    this.#clock = clock;
    this.#audit = audit;
  }

  async projectConfig(input) {
    if (input?.target !== CONFIG_TARGET || input.mode !== 0o444 || input.ownerUid !== 0 || input.ownerGid !== 0
      || input.immutableProviderSet !== true) {
      throw new PlatformError("agent_sandbox_config_projection_denied", "OpenCode configuration projection is outside policy", { status: 403 });
    }
    return this.#project({ ...input, fileClass: "opencode-config", maximumBytes: 128 << 10 });
  }

  async projectSecret(input) {
    const now = this.#clock();
    if (input?.target !== TOKEN_TARGET || input.mode !== 0o400 || input.ownerUid !== 65532 || input.ownerGid !== 65532
      || input.ephemeralMountRequired !== true || typeof input.tokenId !== "string" || !UUID.test(input.tokenId)
      || !(input.expiresAt instanceof Date) || input.expiresAt <= now || input.expiresAt > new Date(now.getTime() + 10 * 60_000)) {
      throw new PlatformError("agent_sandbox_secret_projection_denied", "Agent model credential projection is outside policy", { status: 403 });
    }
    return this.#project({ ...input, fileClass: "model-token", maximumBytes: 8192 });
  }

  async #project(input) {
    if (typeof input.sandboxId !== "string" || !UUID.test(input.sandboxId)
      || typeof input.ownerIdentityId !== "string" || !UUID.test(input.ownerIdentityId)) {
      throw new PlatformError("agent_sandbox_projection_invalid", "Agent sandbox file projection is invalid", { status: 400 });
    }
    const contents = byteBuffer(input.contents, input.maximumBytes);
    const sandbox = await this.#repository.findSandbox(input.sandboxId);
    if (!sandbox || sandbox.ownerIdentityId !== input.ownerIdentityId) {
      throw new PlatformError("agent_sandbox_projection_owner_denied", "Agent sandbox is not owned by the requesting identity", { status: 403 });
    }
    if (sandbox.state !== "running" || !sandbox.nodeId || !sandbox.containerId || !Number.isSafeInteger(sandbox.generation) || sandbox.generation < 1) {
      throw new PlatformError("agent_sandbox_projection_unavailable", "Agent sandbox is not running", { status: 409, retryable: true });
    }
    const contentSha256 = digest(contents);
    const command = {
      sandboxId: sandbox.id,
      workerId: sandbox.workerId,
      nodeId: sandbox.nodeId,
      generation: sandbox.generation,
      ownerIdentityId: sandbox.ownerIdentityId,
      sandboxKey: sandbox.sandboxKey,
      fileClass: input.fileClass,
      contentBase64: contents.toString("base64"),
      contentSha256,
      tokenId: input.fileClass === "model-token" ? input.tokenId : undefined,
      expiresAt: input.fileClass === "model-token" ? input.expiresAt.toISOString() : undefined,
      sensitiveFields: ["contentBase64"],
    };
    const state = runtimeState(await this.#nodeAgent.projectSandboxFile(command), {
      workerId: sandbox.workerId,
      fileClass: input.fileClass,
      contentSha256,
      bytes: contents.length,
    });
    await this.#audit({
      action: "agent.sandbox_file_projected",
      ownerIdentityId: sandbox.ownerIdentityId,
      sandboxId: sandbox.id,
      workerId: sandbox.workerId,
      generation: sandbox.generation,
      fileClass: input.fileClass,
      contentSha256,
      bytes: contents.length,
      tokenId: input.fileClass === "model-token" ? input.tokenId : undefined,
      expiresAt: input.fileClass === "model-token" ? input.expiresAt.toISOString() : undefined,
      occurredAt: this.#clock().toISOString(),
    });
    return Object.freeze({ ...state });
  }
}
