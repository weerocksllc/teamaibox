import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { OpenCodeBridgeClient } from "../../../../services/agent-bridge/src/opencode-bridge-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const UPSTREAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const PINNED_VERSION = "1.18.16";
const PINNED_ARTIFACT = "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41";
const PINNED_ADAPTER = "opencode.http.v1.18";
const ARTIFACT_DELIVERY_CONTEXT = [
  "Team AI Box platform context (not an additional user task):",
  "The user is using the AI Assistant in a browser, not a terminal on this appliance.",
  "After a successful file-writing tool reports its /workspace/ filepath, the platform exports that file to protected storage and adds a downloadable file card to this reply.",
  "For a requested downloadable deliverable, use a file-writing tool that reports the output filepath. Refer to the filename and the file card below the reply; do not tell the user to open a local terminal or retrieve a sandbox path.",
  "A /workspace/ path is not a browser download URL. Do not invent URLs, object IDs or access credentials, and do not say that browser downloads are unsupported.",
  "Do not claim a file was created if the tool failed or was denied. The platform will report any later export failure; successful creation alone is not proof that a download has finished.",
  "Keep the user's requested file contents and action scope unchanged. Answer in the user's language.",
].join("\n");

function ownerKeys(ownerIdentityId) {
  const value = createHash("sha256").update(ownerIdentityId).digest("hex").slice(0, 32);
  return Object.freeze({ sandboxKey: `sandbox.${value}`, workspaceKey: `workspace.${value}` });
}

function safeOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(parsed.hostname)) {
    throw new TypeError("Agent Bridge route origin must be an internal HTTP origin");
  }
  return parsed.origin;
}

function safeTokenFile(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value)
    || value.split("/").includes("..")) throw new TypeError("Agent Bridge token file must be an absolute path");
  return value;
}

async function tokenFromFile(filename) {
  const raw = await readFile(filename);
  try {
    const token = raw.toString("utf8").trim();
    if (token.length < 32 || token.length > 4096 || /[\s\0]/.test(token)) {
      throw new PlatformError("agent_bridge_credential_unavailable", "Agent Bridge credential is unavailable", { status: 503 });
    }
    return token;
  } finally {
    raw.fill(0);
  }
}

export async function loadAssistantAgentBridgeRoutes(filename, { fetchImplementation = globalThis.fetch, provisioner = null } = {}) {
  safeTokenFile(filename);
  const value = JSON.parse(await readFile(filename, "utf8"));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.routes)
    || (value.routes.length === 0 && typeof provisioner?.resolve !== 'function')) {
    throw new TypeError("Assistant Agent Bridge route file is invalid");
  }
  const routes = new Map();
  for (const route of value.routes) {
    if (!UUID.test(route?.ownerIdentityId ?? "") || routes.has(route.ownerIdentityId)
      || typeof route.sandboxKey !== "string" || !SAFE_KEY.test(route.sandboxKey)
      || route.sandboxKey !== ownerKeys(route.ownerIdentityId).sandboxKey) {
      throw new TypeError("Assistant Agent Bridge owner route is invalid or duplicated");
    }
    const origin = safeOrigin(route.origin);
    const tokenFile = safeTokenFile(route.tokenFile);
    routes.set(route.ownerIdentityId, Object.freeze({
      ownerIdentityId: route.ownerIdentityId,
      sandboxKey: route.sandboxKey,
      origin,
      client: new OpenCodeBridgeClient({
        origin,
        tokenProvider: () => tokenFromFile(tokenFile),
        fetchImplementation,
        timeoutMs: 120_000,
      }),
    }));
  }
  return Object.freeze({
    resolve(ownerIdentityId) {
      const route = routes.get(ownerIdentityId);
      if (!route) {
        if (provisioner && UUID.test(ownerIdentityId ?? "")) return provisioner.resolve(ownerIdentityId);
        throw new PlatformError("agent_sandbox_unavailable", "No Agent sandbox is assigned to this user", {
          status: 503,
          retryable: true,
        });
      }
      return route;
    },
    ownerCount: routes.size,
  });
}

function platformError(error, fallback = "agent_execution_failed") {
  if (error instanceof PlatformError) return error;
  return new PlatformError(fallback, "Agent execution failed", { status: 502, retryable: false, cause: error });
}

function safeToolKey(value, prefix) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  if (SAFE_KEY.test(normalized)) return normalized;
  return `${prefix}.${createHash("sha256").update(String(value ?? "unknown")).digest("hex").slice(0, 20)}`;
}

function permissionScope(properties) {
  const permission = String(properties?.permission ?? "unknown");
  const patterns = Array.isArray(properties?.patterns)
    ? properties.patterns.map((item) => String(item))
    : [];
  return Object.freeze({ permission, patterns });
}

function closedEventData(event, fallbackType) {
  const properties = event?.properties;
  const value = {
    type: typeof event?.type === "string" ? event.type.slice(0, 255) : String(fallbackType).slice(0, 255),
  };
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const identifiers = {};
    for (const key of ["id", "sessionID", "messageID", "partID", "requestID"]) {
      if (typeof properties[key] === "string" && properties[key].length <= 512) identifiers[key] = properties[key];
    }
    if (typeof properties.status === "string" && properties.status.length <= 64) identifiers.status = properties.status;
    if (event.type === "permission.asked") Object.assign(identifiers, permissionScope(properties));
    if (Object.keys(identifiers).length) value.properties = identifiers;
  }
  return Object.freeze(value);
}

function finalParts(value) {
  if (Array.isArray(value?.parts)) return value.parts;
  if (Array.isArray(value?.message?.parts)) return value.message.parts;
  return [];
}

function currentTurnParts(messages, promptMessageId, result) {
  const selected = Array.isArray(messages)
    ? messages.filter((message) => message?.info?.role === "assistant" && message?.info?.parentID === promptMessageId)
    : [];
  const parts = [...selected.flatMap(finalParts), ...finalParts(result)];
  const seen = new Set();
  return parts.filter((part) => {
    const id = typeof part?.id === "string" ? part.id : null;
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      return true;
    }
    return false;
  });
}

function currentTurnFailure(messages, promptMessageId, result) {
  const selected = [
    ...(Array.isArray(messages)
      ? messages.filter((message) => message?.info?.role === "assistant" && message?.info?.parentID === promptMessageId)
      : []),
    result,
  ];
  const error = selected.find((message) => message?.info?.error)?.info?.error;
  if (!error) return null;
  const statusCode = Number(error?.data?.statusCode);
  const retryable = error?.data?.isRetryable === true || statusCode === 401 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
  if (statusCode === 401) {
    return new PlatformError("agent_model_credential_rejected", "Agent model credential needs refresh", {
      status: 503,
      retryable: true,
    });
  }
  return new PlatformError("agent_upstream_failed", "Agent model execution failed", {
    status: retryable ? 503 : 502,
    retryable,
  });
}

function usageFrom(value) {
  const tokens = value?.info?.tokens ?? value?.tokens;
  const input = tokens?.input ?? tokens?.prompt ?? tokens?.inputTokens;
  const output = tokens?.output ?? tokens?.completion ?? tokens?.outputTokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    ? { inputTokens: input, outputTokens: output, costMicrounits: 0, currency: "CNY" }
    : null;
}

export class OpenCodeAssistantAgentRunner {
  #sessions;
  #routes;
  #artifacts;
  #id;

  constructor({ sessionService, bridgeRoutes, artifactStore = null, idFactory = randomUUID }) {
    const sessionMethods = [
      "bindConversation", "getBinding", "admitPrompt", "markSubmitting", "markAccepted",
      "markRunning", "completePrompt", "appendEvent",
    ];
    if (!sessionService || sessionMethods.some((method) => typeof sessionService[method] !== "function")
      || typeof bridgeRoutes?.resolve !== "function" || typeof idFactory !== "function") {
      throw new TypeError("Assistant Agent runner dependencies are incomplete");
    }
    if (artifactStore !== null && (!artifactStore?.storeOutput || !artifactStore?.issue)) {
      throw new TypeError("Assistant Agent artifact store is incomplete");
    }
    this.#sessions = sessionService;
    this.#routes = bridgeRoutes;
    this.#artifacts = artifactStore;
    this.#id = idFactory;
  }

  async #exportArtifact({ client, ownerIdentityId, run, path, signal }) {
    if (!this.#artifacts || typeof path !== "string" || !path.startsWith("/workspace/")) return null;
    const exported = await client.readWorkspaceFile({ path, signal });
    try {
      const stored = await this.#artifacts.storeOutput({
        actorIdentityId: ownerIdentityId,
        objectKey: `assistant/runs/${run.id}/${exported.filename}`,
        contentType: exported.mimeType,
        content: exported.content,
        expectedSha256: exported.sha256,
      });
      const reference = await this.#artifacts.issue({
        actorIdentityId: ownerIdentityId,
        objectId: stored.objectId,
        objectVersion: stored.version,
        audience: "assistant.artifact",
        operations: ["head", "read", "range"],
        expiresInSeconds: 300,
      });
      return Object.freeze({
        referenceId: reference.referenceId,
        label: exported.filename,
        mimeType: exported.mimeType,
        sizeBytes: exported.content.byteLength,
      });
    } finally {
      exported.content.fill(0);
    }
  }

  async #binding(ownerIdentityId, conversationId, route, client, signal) {
    try {
      const binding = await this.#sessions.getBinding(ownerIdentityId, conversationId);
      await client.getSession({ sessionId: binding.opencodeSessionId, signal });
      return binding;
    } catch (error) {
      if (error?.code !== "agent_binding_not_found") throw error;
    }
    const session = await client.createSession({ title: "Team AI Box Agent", signal });
    if (!UPSTREAM_ID.test(session?.id ?? "")) {
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge returned an invalid session", { status: 502 });
    }
    const keys = ownerKeys(ownerIdentityId);
    if (route.sandboxKey !== keys.sandboxKey) {
      throw new PlatformError("agent_sandbox_identity_conflict", "Agent sandbox identity does not match the user", { status: 409 });
    }
    return this.#sessions.bindConversation({
      ownerIdentityId,
      platformConversationId: conversationId,
      workspaceKey: keys.workspaceKey,
      sandboxKey: keys.sandboxKey,
      adapterKey: PINNED_ADAPTER,
      upstreamVersion: PINNED_VERSION,
      upstreamArtifactDigest: PINNED_ARTIFACT,
      opencodeSessionId: session.id,
    });
  }

  async run({ ownerIdentityId, run, history, signal, emit, requestConfirmation }) {
    if (!UUID.test(ownerIdentityId ?? "") || !UUID.test(run?.id ?? "") || !UUID.test(run?.conversationId ?? "")
      || !Array.isArray(history) || typeof emit !== "function" || typeof requestConfirmation !== "function") {
      throw new PlatformError("agent_runner_input_invalid", "Agent runner input is invalid", { status: 400 });
    }
    const route = await this.#routes.resolve(ownerIdentityId);
    const client = route.client;
    const binding = await this.#binding(ownerIdentityId, run.conversationId, route, client, signal);
    const current = [...history].reverse().find((message) => message.role === "user" && typeof message.content === "string" && message.content);
    if (!current) throw new PlatformError("agent_prompt_invalid", "Agent prompt is missing", { status: 400 });
    // Describe the actual host UI without patching OpenCode or rewriting its answer.
    // Persist the same parts we send so retries retain the exact prompt identity.
    const parts = [
      ...(this.#artifacts ? [{ type: "text", text: ARTIFACT_DELIVERY_CONTEXT }] : []),
      { type: "text", text: current.content },
    ];
    const prompt = await this.#sessions.admitPrompt(ownerIdentityId, run.conversationId, {
      platformRunId: run.id,
      idempotencyKey: `assistant.${run.id}`,
      model: { providerId: "teamaibox", modelId: "agent.default" },
      parts,
    });
    await this.#sessions.markSubmitting(prompt.id);

    const eventsController = new AbortController();
    const combinedEvents = signal ? AbortSignal.any([signal, eventsController.signal]) : eventsController.signal;
    const connectionId = this.#id();
    let ordinal = 0;
    let eventFailure = null;
    let rejectOnEventFailure;
    const eventFailed = new Promise((_, reject) => { rejectOnEventFailure = reject; });
    const confirmationIds = new Set();
    const consume = (async () => {
      for await (const item of client.events({ signal: combinedEvents })) {
        ordinal += 1;
        await this.#sessions.appendEvent(binding.id, {
          promptId: prompt.id,
          connectionId,
          connectionOrdinal: ordinal,
          upstreamEventId: item.upstreamEventId ?? null,
          type: item.type,
          data: closedEventData(item.event, item.type),
        });
        const event = item.event;
        if (event?.type !== "permission.asked" || event.properties?.sessionID !== binding.opencodeSessionId) continue;
        const requestId = event.properties?.id;
        if (!UPSTREAM_ID.test(requestId ?? "") || confirmationIds.has(requestId)) continue;
        confirmationIds.add(requestId);
        const scope = permissionScope(event.properties);
        const operationKind = safeToolKey(scope.permission, "tool");
        const decision = await requestConfirmation({
          operationKind,
          titleKey: `assistant.confirmation.${operationKind}`,
          scope,
          expiresAt: new Date(Date.now() + 5 * 60_000),
        });
        await client.replyToolConfirmation({
          requestId,
          reply: decision === "approved" ? "once" : "reject",
          message: decision === "approved" ? "Approved for this exact action only" : "Denied by user or timeout",
          signal,
        });
      }
    })().catch((error) => {
      if (!combinedEvents.aborted) {
        eventFailure = error;
        rejectOnEventFailure(error);
      }
    });

    const interrupt = () => { void client.interrupt({ sessionId: binding.opencodeSessionId }).catch(() => {}); };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      const result = await Promise.race([client.prompt({
        sessionId: binding.opencodeSessionId,
        messageId: prompt.opencodeMessageId,
        model: { providerId: "teamaibox", modelId: "agent.default" },
        parts,
        signal,
      }), eventFailed]);
      if (eventFailure) throw eventFailure;
      const messages = await client.listMessages({ sessionId: binding.opencodeSessionId, signal });
      await this.#sessions.markAccepted(prompt.id);
      await this.#sessions.markRunning(prompt.id);
      const upstreamFailure = currentTurnFailure(messages, prompt.opencodeMessageId, result);
      if (upstreamFailure) throw upstreamFailure;
      let visible = false;
      const exportedPaths = new Set();
      for (const part of currentTurnParts(messages, prompt.opencodeMessageId, result)) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          await emit({ type: "text_delta", delta: part.text });
          visible = true;
        } else if (part?.type === "tool") {
          const toolCallId = safeToolKey(part.id ?? part.callID, "toolcall");
          const name = safeToolKey(part.tool ?? part.name, "tool");
          const summary = String(part.state?.metadata?.filepath ?? part.state?.title ?? name);
          await emit({ type: "tool.started", toolCallId, name, summary });
          const status = part.state?.status === "completed" ? "succeeded"
            : part.state?.status === "cancelled" ? "cancelled" : "failed";
          await emit({ type: "tool.completed", toolCallId, status, summary });
          const artifactPath = part.state?.status === "completed" ? part.state?.metadata?.filepath : null;
          if (typeof artifactPath === "string" && !exportedPaths.has(artifactPath)) {
            exportedPaths.add(artifactPath);
            const artifact = await this.#exportArtifact({ client, ownerIdentityId, run, path: artifactPath, signal });
            if (artifact) await emit({ type: "artifact.created", artifact });
          }
          visible = true;
        }
      }
      const usage = usageFrom(result);
      if (usage) await emit({ type: "usage.updated", usage });
      if (!visible) throw new PlatformError("agent_empty_response", "Agent returned no visible result", { status: 502 });
      await this.#sessions.completePrompt(prompt.id, { status: "completed", code: "agent_completed" });
    } catch (error) {
      const normalized = platformError(error);
      try {
        await this.#sessions.completePrompt(prompt.id, {
          status: signal?.aborted ? "cancelled" : "failed",
          code: signal?.aborted ? "agent_cancelled" : safeToolKey(normalized.code, "agent"),
          retryable: normalized.retryable === true,
        });
      } catch {
        // Preserve the original execution failure when the durable terminal write also fails.
      }
      throw normalized;
    } finally {
      signal?.removeEventListener("abort", interrupt);
      eventsController.abort("prompt_terminal");
      await consume;
    }
  }
}

export const assistantAgentRuntime = Object.freeze({
  adapterKey: PINNED_ADAPTER,
  upstreamVersion: PINNED_VERSION,
  upstreamArtifactDigest: PINNED_ARTIFACT,
});
