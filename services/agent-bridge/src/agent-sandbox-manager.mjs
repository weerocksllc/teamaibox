import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicSandbox(value) {
  return Object.freeze({
    id: value.id,
    ownerIdentityId: value.ownerIdentityId,
    workerId: value.workerId,
    sandboxKey: value.sandboxKey,
    workspaceKey: value.workspaceKey,
    workspaceQuotaBytes: value.workspaceQuotaBytes,
    image: value.image,
    state: value.state,
    generation: value.generation,
    activeOperations: value.activeOperations,
    nodeId: value.nodeId,
    containerId: value.containerId,
    lastErrorCode: value.lastErrorCode,
    lastActivityAt: value.lastActivityAt.toISOString(),
    idleDeadlineAt: value.idleDeadlineAt?.toISOString() ?? null,
  });
}

function safeRuntimeResult(value) {
  if (!value || typeof value.containerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,191}$/.test(value.containerId)
    || typeof value.nodeId !== "string" || !UUID.test(value.nodeId)) {
    throw new PlatformError("agent_sandbox_runtime_invalid", "Node Agent returned an invalid sandbox identity", { status: 502 });
  }
  return value;
}

function safeProjectionResult(value, expected) {
  if (!value || value.workerId !== expected.workerId || value.fileClass !== "source-client-config"
    || value.contentSha256 !== expected.contentSha256 || value.bytes !== expected.bytes) {
    throw new PlatformError("agent_source_projection_invalid", "Node Agent returned invalid source configuration evidence", { status: 502 });
  }
  return value;
}

export class AgentSandboxManager {
  #repository;
  #nodeAgent;
  #policy;
  #clock;
  #audit;
  #locks = new Map();

  constructor({ repository, nodeAgent, policy, clock = () => new Date(), audit = async () => {} }) {
    const methods = ["ensureSandbox", "findByOwner", "findSandbox", "updateSandbox", "acquireOperation", "releaseOperation", "claimIdle"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")) throw new TypeError("Agent sandbox repository is incomplete");
    if (!nodeAgent?.startSandbox || !nodeAgent?.stopSandbox || !nodeAgent?.projectSandboxFile || !policy?.compile || !policy?.identity
      || !Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs < 30_000) {
      throw new TypeError("Agent sandbox runtime dependencies are incomplete");
    }
    this.#repository = repository;
    this.#nodeAgent = nodeAgent;
    this.#policy = policy;
    this.#clock = clock;
    this.#audit = audit;
  }

  async acquire(ownerIdentityId, { image, egressHosts = [], limits = {}, requested = {} }) {
    if (typeof ownerIdentityId !== "string" || !UUID.test(ownerIdentityId)) throw new PlatformError("agent_sandbox_owner_invalid", "Agent sandbox owner identity is invalid", { status: 400 });
    return this.#exclusive(ownerIdentityId, async () => {
      const identity = this.#policy.identity(ownerIdentityId);
      const workerId = randomUUID();
      const compiled = this.#policy.compile({ ownerIdentityId, workerId, image, egressHosts, limits, requested });
      const now = this.#clock();
      const ensured = await this.#repository.ensureSandbox({
        id: randomUUID(), ownerIdentityId, workerId,
        sandboxKey: identity.sandboxKey, workspaceKey: identity.workspaceKey,
        workspaceVolume: identity.workspaceVolume, workspaceQuotaBytes: compiled.workspaceQuotaBytes,
        image, runtimeFingerprint: compiled.runtimeFingerprint,
        state: "stopped", generation: 0, activeOperations: 0,
        nodeId: null, containerId: null, lastErrorCode: null,
        lastActivityAt: now, idleDeadlineAt: null, revision: 1,
        createdAt: now, updatedAt: now,
      });
      let sandbox = ensured.sandbox;
      const currentSpec = this.#policy.compile({ ownerIdentityId, workerId: sandbox.workerId, image, egressHosts, limits, requested });
      const immutable = ["sandboxKey", "workspaceKey", "workspaceVolume"];
      if (immutable.some((key) => sandbox[key] !== identity[key])) {
        throw new PlatformError("agent_sandbox_identity_conflict", "Agent sandbox is bound to different owner storage", { status: 409 });
      }
      if (sandbox.state === "running" && sandbox.runtimeFingerprint !== currentSpec.runtimeFingerprint) {
        throw new PlatformError("agent_sandbox_runtime_conflict", "Running Agent sandbox uses different runtime policy", { status: 409 });
      }
      if (new Set(["stopped", "error"]).has(sandbox.state)) {
        const starting = {
          ...sandbox,
          image,
          runtimeFingerprint: currentSpec.runtimeFingerprint,
          workspaceQuotaBytes: currentSpec.workspaceQuotaBytes,
          state: "starting",
          lastErrorCode: null,
          revision: sandbox.revision + 1,
          updatedAt: now,
        };
        sandbox = await this.#repository.updateSandbox(starting, sandbox.revision);
        let runtime = null;
        try {
          runtime = safeRuntimeResult(await this.#nodeAgent.startSandbox({
            sandboxId: sandbox.id,
            generation: sandbox.generation + 1,
            workspaceQuotaBytes: sandbox.workspaceQuotaBytes,
            spec: currentSpec.nodeSpec,
          }));
          const sourceContents = Buffer.from(JSON.stringify(currentSpec.sourceClientConfig));
          const contentSha256 = createHash("sha256").update(sourceContents).digest("hex");
          try {
            safeProjectionResult(await this.#nodeAgent.projectSandboxFile({
              sandboxId: sandbox.id,
              workerId: sandbox.workerId,
              nodeId: runtime.nodeId,
              generation: sandbox.generation + 1,
              ownerIdentityId,
              sandboxKey: sandbox.sandboxKey,
              fileClass: "source-client-config",
              contentBase64: sourceContents.toString("base64"),
              contentSha256,
              sensitiveFields: [],
            }), { workerId: sandbox.workerId, contentSha256, bytes: sourceContents.length });
          } finally {
            sourceContents.fill(0);
          }
          const startedAt = this.#clock();
          sandbox = await this.#repository.updateSandbox({
            ...sandbox,
            state: "running",
            generation: sandbox.generation + 1,
            nodeId: runtime.nodeId,
            containerId: runtime.containerId,
            lastErrorCode: null,
            lastActivityAt: startedAt,
            idleDeadlineAt: null,
            revision: sandbox.revision + 1,
            updatedAt: startedAt,
          }, sandbox.revision);
          await this.#audit({ action: "agent.sandbox_started", ownerIdentityId, sandboxId: sandbox.id, generation: sandbox.generation, occurredAt: startedAt.toISOString() });
        } catch (error) {
          const failedAt = this.#clock();
          const code = error instanceof PlatformError ? error.code : "node_agent_start_failed";
          if (runtime) {
            try {
              await this.#nodeAgent.stopSandbox({
                sandboxId: sandbox.id, workerId: sandbox.workerId, nodeId: runtime.nodeId,
                generation: sandbox.generation + 1, gracePeriodSeconds: 5,
              });
            } catch {
              // The durable error state drives later reconciliation; never hide
              // the original start/projection failure with cleanup detail.
            }
          }
          await this.#repository.updateSandbox({
            ...sandbox, state: "error", nodeId: null, containerId: null,
            lastErrorCode: code, revision: sandbox.revision + 1, updatedAt: failedAt,
          }, sandbox.revision);
          await this.#audit({ action: "agent.sandbox_start_failed", ownerIdentityId, sandboxId: sandbox.id, code, occurredAt: failedAt.toISOString() });
          throw error;
        }
      } else if (sandbox.state !== "running") {
        throw new PlatformError("agent_sandbox_busy", "Agent sandbox lifecycle operation is in progress", { status: 409, retryable: true });
      }
      const operationId = randomUUID();
      const acquired = await this.#repository.acquireOperation({ operationId, sandboxId: sandbox.id, now: this.#clock() });
      return Object.freeze({ operationId, sandbox: publicSandbox(acquired.sandbox), nodeSpec: currentSpec.nodeSpec });
    });
  }

  async release(operationId) {
    if (typeof operationId !== "string" || !UUID.test(operationId)) throw new PlatformError("agent_operation_invalid", "Agent sandbox operation identity is invalid", { status: 400 });
    const now = this.#clock();
    const result = await this.#repository.releaseOperation({
      operationId,
      now,
      idleDeadlineAt: new Date(now.getTime() + this.#policy.idleTimeoutMs),
    });
    if (!result) throw new PlatformError("agent_operation_not_found", "Agent sandbox operation does not exist", { status: 404 });
    return Object.freeze({ released: result.released, sandbox: publicSandbox(result.sandbox) });
  }

  async stopIdle({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PlatformError("agent_idle_limit_invalid", "Agent idle sweep limit is invalid", { status: 400 });
    const claimed = await this.#repository.claimIdle({ now: this.#clock(), limit });
    const results = [];
    for (const value of claimed) {
      try {
        await this.#nodeAgent.stopSandbox({
          sandboxId: value.id, workerId: value.workerId, nodeId: value.nodeId,
          generation: value.generation, gracePeriodSeconds: 15,
        });
        const stoppedAt = this.#clock();
        const stopped = await this.#repository.updateSandbox({
          ...value, state: "stopped", nodeId: null, containerId: null,
          lastErrorCode: null, idleDeadlineAt: null, revision: value.revision + 1,
          updatedAt: stoppedAt,
        }, value.revision);
        await this.#audit({ action: "agent.sandbox_idle_stopped", ownerIdentityId: value.ownerIdentityId, sandboxId: value.id, occurredAt: stoppedAt.toISOString() });
        results.push({ sandbox: publicSandbox(stopped), stopped: true });
      } catch (error) {
        const failedAt = this.#clock();
        const code = error instanceof PlatformError ? error.code : "node_agent_stop_failed";
        const failed = await this.#repository.updateSandbox({
          ...value, state: "error", lastErrorCode: code, revision: value.revision + 1, updatedAt: failedAt,
        }, value.revision);
        results.push({ sandbox: publicSandbox(failed), stopped: false });
      }
    }
    return Object.freeze(results.map(Object.freeze));
  }

  async #exclusive(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => next);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}
