import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { bufferedMediaBytes } from "../../../../services/object-service/src/buffered-media-budget.mjs";

const MODES = new Set(["auto", "answer", "agent"]);
const EFFECTIVE_MODES = new Set(["answer", "agent"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const SAFE_MODEL = /^[^\s\u0000-\u001f]{1,512}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,511}$/;

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function publicConversation(conversation) {
  return Object.freeze({
    id: conversation.id,
    object: "assistant.conversation",
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  });
}

function publicMessage(message, error = null) {
  return Object.freeze({
    id: message.id,
    object: "assistant.message",
    conversationId: message.conversationId,
    runId: message.runId,
    role: message.role,
    content: message.content,
    requestedMode: message.requestedMode,
    effectiveMode: message.effectiveMode,
    status: message.status,
    artifacts: Object.freeze(copy(message.artifacts)),
    sources: Object.freeze(copy(message.sources)),
    toolCalls: Object.freeze(copy(message.toolCalls)),
    routing: message.routing ? Object.freeze(copy(message.routing)) : null,
    usage: message.usage ? Object.freeze(copy(message.usage)) : null,
    error: error ? Object.freeze(copy(error)) : null,
    createdAt: message.createdAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  });
}

function publicRun(run) {
  return Object.freeze({
    id: run.id,
    object: "assistant.run",
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    requestedMode: run.requestedMode,
    effectiveMode: run.effectiveMode,
    status: run.status,
    routing: Object.freeze(copy(run.routing)),
    pendingConfirmationId: run.pendingConfirmationId,
    error: run.error ? Object.freeze(copy(run.error)) : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  });
}

function publicEvent(event) {
  return Object.freeze({
    id: event.id,
    sequence: event.sequence,
    conversationId: event.conversationId,
    runId: event.runId,
    type: event.type,
    data: Object.freeze(copy(event.data)),
    createdAt: event.createdAt.toISOString(),
  });
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function defaultRoutingPolicy({ requestedMode, content }) {
  const agentIntent = /(?:\b(?:write|modify|edit|execute|run|install|create|build|code)\b|写入|修改|编辑|执行|运行|安装|创建|编程|代码)/iu.test(content);
  const effectiveMode = requestedMode === "auto" ? (agentIntent ? "agent" : "answer") : requestedMode;
  return {
    effectiveMode,
    targetKind: "internal",
    providerKey: "platform.compute",
    modelKey: effectiveMode === "agent" ? "auto.agent" : "auto.answer",
    profileKey: null,
    reasonKey: requestedMode === "auto"
      ? (agentIntent ? "assistant.routing.agent_intent" : "assistant.routing.answer_intent")
      : "assistant.routing.user_selected",
  };
}

function validateRouting(value) {
  if (!value || !EFFECTIVE_MODES.has(value.effectiveMode)
    || !new Set(["internal", "external"]).has(value.targetKind)
    || typeof value.providerKey !== "string" || !SAFE_KEY.test(value.providerKey)
    || typeof value.modelKey !== "string" || !SAFE_MODEL.test(value.modelKey)
    || (value.profileKey !== null && value.profileKey !== undefined
      && (typeof value.profileKey !== "string" || !SAFE_KEY.test(value.profileKey)))
    || typeof value.reasonKey !== "string" || !SAFE_KEY.test(value.reasonKey)) {
    throw new PlatformError("assistant_routing_invalid", "Assistant routing policy returned an invalid route", { status: 502 });
  }
  return Object.freeze({
    effectiveMode: value.effectiveMode,
    targetKind: value.targetKind,
    providerKey: value.providerKey,
    modelKey: value.modelKey,
    profileKey: value.profileKey ?? null,
    reasonKey: value.reasonKey,
  });
}

function requestDigest({ content, requestedMode, inputReferenceIds = [] }) {
  return `sha256:${createHash("sha256").update(JSON.stringify({ content, requestedMode, inputReferenceIds })).digest("hex")}`;
}

function cancellationError() {
  const error = new Error("Assistant run was cancelled");
  error.name = "AbortError";
  return error;
}

export class AssistantService {
  #repository;
  #runners;
  #routingPolicy;
  #taskCenter;
  #clock;
  #audit;
  #artifactHandoff;
  #controllers = new Map();
  #confirmationWaiters = new Map();
  #executions = new Map();

  constructor({
    repository,
    answerRunner,
    agentRunner,
    routingPolicy = defaultRoutingPolicy,
    taskCenter = null,
    clock = () => new Date(),
    audit = async () => {},
    artifactHandoff = null,
  }) {
    const repositoryMethods = [
      "insertConversation", "findOwnedConversation", "listOwnedConversations", "updateConversation",
      "insertSubmission", "listMessages", "findMessage", "updateMessage", "findRun", "findOwnedRun",
      "updateRun", "appendEvent", "listEvents", "waitForEvents",
    ];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("assistant repository is incomplete");
    }
    if (!answerRunner?.run || !agentRunner?.run) throw new TypeError("assistant answer and Agent runners are required");
    if (typeof routingPolicy !== "function") throw new TypeError("assistant routing policy is required");
    if (artifactHandoff !== null && (!artifactHandoff?.resolveInputs || !artifactHandoff?.registerOutput || !artifactHandoff?.issueDownload)) {
      throw new TypeError("assistant artifact handoff is incomplete");
    }
    this.#repository = repository;
    this.#runners = Object.freeze({ answer: answerRunner, agent: agentRunner });
    this.#routingPolicy = routingPolicy;
    this.#taskCenter = taskCenter;
    this.#clock = clock;
    this.#audit = audit;
    this.#artifactHandoff = artifactHandoff;
  }

  async createConversation(ownerIdentityId, { title = null } = {}) {
    const now = this.#clock();
    const normalizedTitle = title === null || title === undefined || String(title).trim() === ""
      ? null
      : String(title).trim();
    if (normalizedTitle && normalizedTitle.length > 160) {
      throw new PlatformError("assistant_title_invalid", "Conversation title is too long", { status: 400 });
    }
    const conversation = {
      id: randomUUID(), ownerIdentityId, title: normalizedTitle,
      createdAt: now, updatedAt: now,
    };
    await this.#repository.insertConversation(conversation);
    await this.#audit({ action: "assistant.conversation_created", ownerIdentityId, conversationId: conversation.id, occurredAt: now.toISOString() });
    return publicConversation(conversation);
  }

  async listConversations(ownerIdentityId) {
    return Object.freeze((await this.#repository.listOwnedConversations(ownerIdentityId)).map(publicConversation));
  }

  async getConversation(ownerIdentityId, conversationId) {
    const conversation = await this.#ownedConversation(ownerIdentityId, conversationId);
    const messages = await this.#repository.listMessages(conversation.id);
    const events = await this.#repository.listEvents(conversation.id, 0);
    const runIds = new Set(messages.map((message) => message.runId));
    const confirmations = this.#taskCenter
      ? (await this.#taskCenter.listOwnAgentConfirmations(ownerIdentityId))
        .filter((confirmation) => confirmation.agentSessionKey.startsWith("assistant-run.")
          && runIds.has(confirmation.agentSessionKey.slice("assistant-run.".length)))
      : [];
    const projectedMessages = await Promise.all(messages.map(async (message) => {
      if (message.role !== "assistant") return publicMessage(message);
      const run = await this.#repository.findRun(message.runId);
      return publicMessage(message, run?.error ?? null);
    }));
    return Object.freeze({
      ...publicConversation(conversation),
      messages: Object.freeze(projectedMessages),
      confirmations: Object.freeze(confirmations),
      eventCursor: events.at(-1)?.sequence ?? 0,
    });
  }

  async submitMessage(ownerIdentityId, conversationId, {
    content,
    mode = "auto",
    idempotencyKey = randomUUID(),
    inputReferenceIds = [],
  }) {
    const conversation = await this.#ownedConversation(ownerIdentityId, conversationId);
    const normalizedContent = typeof content === "string" ? content.trim() : "";
    if (!normalizedContent) {
      throw new PlatformError("assistant_input_invalid", "Assistant input must not be empty", { status: 400 });
    }
    if (!MODES.has(mode)) throw new PlatformError("assistant_mode_invalid", "Assistant mode is invalid", { status: 400 });
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new PlatformError("assistant_idempotency_invalid", "Assistant idempotency key is invalid", { status: 400 });
    }
    if (!Array.isArray(inputReferenceIds)
      || new Set(inputReferenceIds).size !== inputReferenceIds.length
      || inputReferenceIds.some((value) => typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))) {
      throw new PlatformError("assistant_artifact_input_invalid", "Assistant input artifacts are invalid", { status: 400 });
    }
    const history = await this.#repository.listMessages(conversation.id);
    const routing = validateRouting(await this.#routingPolicy({
      ownerIdentityId, conversationId, requestedMode: mode, content: normalizedContent,
      history: copy(history.map(publicMessage)),
    }));
    const now = this.#clock();
    const runId = randomUUID();
    const inputArtifacts = this.#artifactHandoff
      ? await this.#artifactHandoff.resolveInputs({ ownerIdentityId, runId, referenceIds: inputReferenceIds })
      : [];
    if (!this.#artifactHandoff && inputReferenceIds.length) {
      throw new PlatformError("assistant_artifact_unavailable", "Assistant artifact handoff is unavailable", { status: 503 });
    }
    const userMessage = {
      id: randomUUID(), conversationId, runId, role: "user", content: normalizedContent,
      requestedMode: mode, effectiveMode: routing.effectiveMode, status: "completed",
      artifacts: copy(inputArtifacts), sources: [], toolCalls: [], routing: copy(routing), usage: null,
      createdAt: now, completedAt: now,
    };
    const assistantMessage = {
      id: randomUUID(), conversationId, runId, role: "assistant", content: "",
      requestedMode: mode, effectiveMode: routing.effectiveMode, status: "streaming",
      artifacts: [], sources: [], toolCalls: [], routing: copy(routing), usage: null,
      createdAt: now, completedAt: null,
    };
    const run = {
      id: runId, ownerIdentityId, conversationId,
      userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
      requestedMode: mode, effectiveMode: routing.effectiveMode,
      status: "queued", routing: copy(routing), pendingConfirmationId: null,
      error: null, createdAt: now, startedAt: null, completedAt: null,
    };
    const initialEvents = [
      this.#event(run, "message.created", { message: publicMessage(userMessage) }, now),
      this.#event(run, "run.created", { run: publicRun(run) }, now),
      this.#event(run, "routing.selected", { requestedMode: mode, ...copy(routing) }, now),
      this.#event(run, "message.created", { message: publicMessage(assistantMessage) }, now),
    ];
    const digest = requestDigest({ content: normalizedContent, requestedMode: mode, inputReferenceIds });
    const result = await this.#repository.insertSubmission({
      userMessage, assistantMessage, run, idempotencyKey, requestDigest: digest, events: initialEvents,
    });
    if (!result) throw new PlatformError("assistant_conversation_not_found", "Assistant conversation was not found", { status: 404 });
    if (!result.inserted) {
      if (result.requestDigest !== digest) {
        throw new PlatformError("assistant_idempotency_conflict", "Idempotency key was reused with different message facts", { status: 409 });
      }
      return Object.freeze({ replayed: true, run: publicRun(result.run) });
    }
    conversation.updatedAt = now;
    if (!conversation.title) conversation.title = normalizedContent.slice(0, 72);
    await this.#repository.updateConversation(conversation);
    const execution = this.#execute(run.id);
    this.#executions.set(run.id, execution);
    void execution.finally(() => this.#executions.delete(run.id));
    await this.#audit({
      action: "assistant.message_submitted", ownerIdentityId, conversationId, runId,
      requestedMode: mode, effectiveMode: routing.effectiveMode, occurredAt: now.toISOString(),
    });
    return Object.freeze({ replayed: false, run: publicRun(run) });
  }

  async cancelRun(ownerIdentityId, runId) {
    const run = await this.#ownedRun(ownerIdentityId, runId);
    if (TERMINAL_RUN_STATES.has(run.status)) return publicRun(run);
    this.#controllers.get(run.id)?.abort(cancellationError());
    await this.#finalizeCancelled(run.id);
    return publicRun(await this.#repository.findRun(run.id));
  }

  async artifactDownload(ownerIdentityId, artifactId) {
    if (!this.#artifactHandoff) throw new PlatformError("assistant_artifact_unavailable", "Assistant artifact handoff is unavailable", { status: 503 });
    return this.#artifactHandoff.issueDownload({ ownerIdentityId, artifactId });
  }

  async decideConfirmation(ownerIdentityId, confirmationId, decision) {
    if (!this.#taskCenter) throw new PlatformError("assistant_confirmation_unavailable", "Agent confirmation service is unavailable", { status: 503 });
    const confirmation = await this.#taskCenter.decideAgentConfirmation(ownerIdentityId, confirmationId, decision);
    const pending = this.#confirmationWaiters.get(confirmationId);
    if (pending) await this.#resolveConfirmation(confirmationId, confirmation);
    return confirmation;
  }

  async listEvents(ownerIdentityId, conversationId, afterSequence = 0) {
    await this.#ownedConversation(ownerIdentityId, conversationId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new PlatformError("assistant_cursor_invalid", "Assistant event cursor is invalid", { status: 400 });
    }
    return Object.freeze((await this.#repository.listEvents(conversationId, afterSequence)).map(publicEvent));
  }

  async *streamEvents(ownerIdentityId, conversationId, { afterSequence = 0, once = false, signal } = {}) {
    await this.#ownedConversation(ownerIdentityId, conversationId);
    let cursor = afterSequence;
    do {
      const events = await this.listEvents(ownerIdentityId, conversationId, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield Object.freeze({ id: String(event.sequence), event: event.type, data: event });
      }
      if (once || signal?.aborted) return;
      await this.#repository.waitForEvents(conversationId, cursor, { signal, timeoutMs: 15_000 });
      if (signal?.aborted) return;
      const next = await this.#repository.listEvents(conversationId, cursor);
      if (next.length === 0) {
        yield Object.freeze({ event: "assistant.heartbeat", data: { conversationId, cursor } });
      }
    } while (!signal?.aborted);
  }

  async waitForRun(runId) {
    const execution = this.#executions.get(runId);
    if (execution) await execution;
    const run = await this.#repository.findRun(runId);
    return run ? publicRun(run) : null;
  }

  async #execute(runId) {
    const run = await this.#repository.findRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    run.status = "running";
    run.startedAt = this.#clock();
    await this.#repository.updateRun(run);
    await this.#appendEvent(run, "run.started", { run: publicRun(run) });
    const history = (await this.#repository.listMessages(run.conversationId))
      .filter((message) => message.id !== run.assistantMessageId)
      .map(publicMessage);
    const runner = this.#runners[run.effectiveMode];
    try {
      await runner.run(Object.freeze({
        ownerIdentityId: run.ownerIdentityId,
        run: publicRun(run),
        history: Object.freeze(history),
        signal: controller.signal,
        emit: (output) => this.#applyRunnerOutput(run.id, output),
        requestConfirmation: (request) => this.#requestConfirmation(run.id, request),
      }));
      if (controller.signal.aborted) throw cancellationError();
      const current = await this.#repository.findRun(run.id);
      if (!current || TERMINAL_RUN_STATES.has(current.status)) return;
      const message = await this.#repository.findMessage(current.conversationId, current.assistantMessageId);
      if (!message || (!message.content && message.artifacts.length === 0 && message.toolCalls.length === 0)) {
        throw new PlatformError("assistant_empty_response", "Assistant execution returned no visible result", { status: 502 });
      }
      message.status = "completed";
      message.completedAt = this.#clock();
      await this.#repository.updateMessage(message);
      current.status = "completed";
      current.completedAt = message.completedAt;
      await this.#repository.updateRun(current);
      await this.#appendEvent(current, "message.completed", { message: publicMessage(message) });
      await this.#appendEvent(current, "run.completed", { run: publicRun(current) });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        await this.#finalizeCancelled(run.id);
      } else {
        await this.#finalizeFailed(run.id, error);
      }
    } finally {
      this.#controllers.delete(run.id);
    }
  }

  async #applyRunnerOutput(runId, output) {
    const run = await this.#repository.findRun(runId);
    if (!run || run.status !== "running") throw cancellationError();
    const message = await this.#repository.findMessage(run.conversationId, run.assistantMessageId);
    if (!message || !output || typeof output !== "object") {
      throw new PlatformError("assistant_runner_invalid", "Assistant runner returned an invalid event", { status: 502 });
    }
    if (output.type === "text_delta") {
      if (typeof output.delta !== "string" || !output.delta) {
        throw new PlatformError("assistant_runner_invalid", "Assistant text delta is invalid", { status: 502 });
      }
      if ((message.content.length + output.delta.length) * 2 > bufferedMediaBytes()) {
        throw new PlatformError("assistant_memory_unavailable", "当前服务内存不足，暂时无法继续处理回答", { status: 503, retryable: true });
      }
      message.content += output.delta;
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "response.delta", { messageId: message.id, delta: output.delta });
      return;
    }
    if (output.type === "tool.started") {
      if (run.effectiveMode !== "agent" || typeof output.toolCallId !== "string" || !SAFE_KEY.test(output.toolCallId)
        || typeof output.name !== "string" || !SAFE_KEY.test(output.name)) {
        throw new PlatformError("assistant_runner_invalid", "Assistant tool event is invalid", { status: 502 });
      }
      const tool = { id: output.toolCallId, name: output.name, summary: String(output.summary ?? ""), status: "running", startedAt: this.#clock().toISOString(), completedAt: null };
      message.toolCalls.push(tool);
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "tool.started", { tool });
      return;
    }
    if (output.type === "tool.completed") {
      const tool = message.toolCalls.find((candidate) => candidate.id === output.toolCallId);
      if (!tool || !new Set(["succeeded", "failed", "cancelled"]).has(output.status)) {
        throw new PlatformError("assistant_runner_invalid", "Assistant tool completion is invalid", { status: 502 });
      }
      tool.status = output.status;
      tool.summary = String(output.summary ?? tool.summary);
      tool.completedAt = this.#clock().toISOString();
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "tool.completed", { tool });
      return;
    }
    if (output.type === "artifact.created") {
      const artifact = output.artifact;
      if (!artifact || typeof artifact.referenceId !== "string" || !SAFE_REFERENCE.test(artifact.referenceId)
        || typeof artifact.label !== "string" || !artifact.label.trim()
        || typeof artifact.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.mimeType)
        || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
        throw new PlatformError("assistant_runner_invalid", "Assistant artifact is invalid", { status: 502 });
      }
      let normalized;
      if (this.#artifactHandoff) {
        const inputMessage = await this.#repository.findMessage(run.conversationId, run.userMessageId);
        normalized = await this.#artifactHandoff.registerOutput({
          ownerIdentityId: run.ownerIdentityId, runId: run.id, referenceId: artifact.referenceId,
          label: artifact.label, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes,
          inputArtifacts: inputMessage?.artifacts ?? [],
        });
      } else {
        normalized = {
          referenceId: artifact.referenceId, label: artifact.label.trim().slice(0, 240),
          mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes,
          downloadPath: typeof artifact.downloadPath === "string" && artifact.downloadPath.startsWith("/") ? artifact.downloadPath : null,
        };
      }
      message.artifacts.push(normalized);
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "artifact.created", { artifact: normalized });
      return;
    }
    if (output.type === "source.cited") {
      const source = output.source;
      let url = null;
      if (source?.url !== null && source?.url !== undefined) {
        try {
          const parsed = new URL(source.url, "https://assistant.invalid");
          if ((parsed.protocol !== "https:" && !String(source.url).startsWith("/")) || parsed.username || parsed.password) throw new Error("unsafe URL");
          url = String(source.url);
        } catch {
          throw new PlatformError("assistant_runner_invalid", "Assistant source URL is invalid", { status: 502 });
        }
      }
      if (!source || typeof source.referenceId !== "string" || !SAFE_REFERENCE.test(source.referenceId)
        || typeof source.label !== "string" || !source.label.trim()) {
        throw new PlatformError("assistant_runner_invalid", "Assistant source is invalid", { status: 502 });
      }
      const normalized = { referenceId: source.referenceId, label: source.label.trim().slice(0, 240), url };
      message.sources.push(normalized);
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "source.cited", { source: normalized });
      return;
    }
    if (output.type === "usage.updated") {
      const usage = output.usage;
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
        || !Number.isSafeInteger(usage.costMicrounits ?? 0) || (usage.costMicrounits ?? 0) < 0) {
        throw new PlatformError("assistant_runner_invalid", "Assistant usage event is invalid", { status: 502 });
      }
      message.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicrounits: usage.costMicrounits ?? 0, currency: usage.currency ?? "CNY" };
      await this.#repository.updateMessage(message);
      await this.#appendEvent(run, "usage.updated", { usage: message.usage });
      return;
    }
    throw new PlatformError("assistant_runner_invalid", "Assistant runner event type is unsupported", { status: 502 });
  }

  async #requestConfirmation(runId, request) {
    const run = await this.#repository.findRun(runId);
    if (!run || run.status !== "running") throw cancellationError();
    if (run.effectiveMode !== "agent" || !this.#taskCenter) {
      throw new PlatformError("assistant_confirmation_unavailable", "Agent operation confirmation is unavailable", { status: 503 });
    }
    if (!request || typeof request.operationKind !== "string" || !SAFE_KEY.test(request.operationKind)
      || typeof request.titleKey !== "string" || !SAFE_KEY.test(request.titleKey)
      || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) {
      throw new PlatformError("assistant_runner_invalid", "Agent confirmation request is invalid", { status: 502 });
    }
    const expiresAt = validDate(request.expiresAt ?? new Date(this.#clock().getTime() + 5 * 60_000));
    if (!expiresAt || expiresAt <= this.#clock()) {
      throw new PlatformError("assistant_runner_invalid", "Agent confirmation expiry is invalid", { status: 502 });
    }
    const confirmation = await this.#taskCenter.createAgentConfirmation({
      ownerIdentityId: run.ownerIdentityId,
      agentSessionKey: `assistant-run.${run.id}`,
      operationKind: request.operationKind,
      titleKey: request.titleKey,
      scope: request.scope,
      expiresAt,
    });
    run.pendingConfirmationId = confirmation.id;
    await this.#repository.updateRun(run);
    await this.#appendEvent(run, "confirmation.requested", { confirmation });
    return new Promise((resolve, reject) => {
      const controller = this.#controllers.get(run.id);
      const onAbort = () => {
        const pending = this.#confirmationWaiters.get(confirmation.id);
        if (pending?.timer) clearTimeout(pending.timer);
        this.#confirmationWaiters.delete(confirmation.id);
        reject(cancellationError());
      };
      controller?.signal.addEventListener("abort", onAbort, { once: true });
      const pending = {
        runId: run.id,
        ownerIdentityId: run.ownerIdentityId,
        expiresAt,
        timer: null,
        resolve: (decision) => {
          controller?.signal.removeEventListener("abort", onAbort);
          resolve(decision);
        },
        reject: (error) => {
          controller?.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      this.#confirmationWaiters.set(confirmation.id, pending);
      this.#scheduleConfirmationExpiry(confirmation.id);
    });
  }

  #scheduleConfirmationExpiry(confirmationId) {
    const pending = this.#confirmationWaiters.get(confirmationId);
    if (!pending) return;
    const remaining = Math.max(0, pending.expiresAt.getTime() - this.#clock().getTime());
    pending.timer = setTimeout(() => {
      void this.#expireConfirmation(confirmationId).catch((error) => {
        const current = this.#confirmationWaiters.get(confirmationId);
        if (!current) return;
        this.#confirmationWaiters.delete(confirmationId);
        current.reject(error);
      });
    }, Math.min(remaining, 2_147_483_647));
    pending.timer.unref?.();
  }

  async #expireConfirmation(confirmationId) {
    const pending = this.#confirmationWaiters.get(confirmationId);
    if (!pending) return;
    const confirmations = await this.#taskCenter.listOwnAgentConfirmations(pending.ownerIdentityId);
    const confirmation = confirmations.find((candidate) => candidate.id === confirmationId);
    if (!confirmation || confirmation.status === "pending") {
      this.#scheduleConfirmationExpiry(confirmationId);
      return;
    }
    await this.#resolveConfirmation(confirmationId, confirmation);
  }

  async #resolveConfirmation(confirmationId, confirmation) {
    const pending = this.#confirmationWaiters.get(confirmationId);
    if (!pending) return;
    this.#confirmationWaiters.delete(confirmationId);
    if (pending.timer) clearTimeout(pending.timer);
    const run = await this.#repository.findRun(pending.runId);
    if (run) {
      run.pendingConfirmationId = null;
      await this.#repository.updateRun(run);
      await this.#appendEvent(run, "confirmation.resolved", { confirmation });
    }
    pending.resolve(confirmation.status);
  }

  async #finalizeCancelled(runId) {
    const run = await this.#repository.findRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;
    const now = this.#clock();
    const pendingConfirmationId = run.pendingConfirmationId;
    if (pendingConfirmationId && this.#taskCenter?.cancelAgentConfirmation) {
      const confirmation = await this.#taskCenter.cancelAgentConfirmation(run.ownerIdentityId, pendingConfirmationId);
      await this.#appendEvent(run, "confirmation.resolved", { confirmation });
    }
    const message = await this.#repository.findMessage(run.conversationId, run.assistantMessageId);
    if (message) {
      message.status = "cancelled";
      message.completedAt = now;
      await this.#repository.updateMessage(message);
    }
    run.status = "cancelled";
    run.completedAt = now;
    run.pendingConfirmationId = null;
    await this.#repository.updateRun(run);
    await this.#appendEvent(run, "run.cancelled", { run: publicRun(run) });
  }

  async #finalizeFailed(runId, error) {
    const run = await this.#repository.findRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;
    const now = this.#clock();
    const code = typeof error?.code === "string" && SAFE_KEY.test(error.code) ? error.code : "assistant_execution_failed";
    run.status = "failed";
    run.completedAt = now;
    run.pendingConfirmationId = null;
    run.error = { code, message: "Assistant execution could not be completed", retryable: Boolean(error?.retryable) };
    await this.#repository.updateRun(run);
    const message = await this.#repository.findMessage(run.conversationId, run.assistantMessageId);
    if (message) {
      message.status = "failed";
      message.completedAt = now;
      await this.#repository.updateMessage(message);
    }
    await this.#appendEvent(run, "run.failed", { run: publicRun(run), error: run.error });
  }

  #event(run, type, data, createdAt = this.#clock()) {
    return { id: randomUUID(), conversationId: run.conversationId, runId: run.id, type, data: copy(data), createdAt };
  }

  async #appendEvent(run, type, data) {
    return publicEvent(await this.#repository.appendEvent(this.#event(run, type, data)));
  }

  async #ownedConversation(ownerIdentityId, conversationId) {
    const conversation = await this.#repository.findOwnedConversation(ownerIdentityId, conversationId);
    if (!conversation) throw new PlatformError("assistant_conversation_not_found", "Assistant conversation was not found", { status: 404 });
    return conversation;
  }

  async #ownedRun(ownerIdentityId, runId) {
    const run = await this.#repository.findOwnedRun(ownerIdentityId, runId);
    if (!run) throw new PlatformError("assistant_run_not_found", "Assistant run was not found", { status: 404 });
    return run;
  }
}

export const assistantModes = Object.freeze([...MODES]);
export { defaultRoutingPolicy };
