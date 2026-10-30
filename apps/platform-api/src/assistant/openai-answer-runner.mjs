import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function safeOrigin(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Assistant compute gateway must be an HTTP(S) origin");
  }
  return parsed.origin;
}

function safeModel(value) {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f]{1,512}$/u.test(value)) {
    throw new TypeError("Assistant compute model is invalid");
  }
  return value;
}

function errorFromStatus(status) {
  if (status === 429) return new PlatformError("assistant_compute_busy", "Assistant compute capacity is busy", { status: 503, retryable: true });
  if (status >= 500) return new PlatformError("assistant_compute_unavailable", "Assistant compute gateway is unavailable", { status: 503, retryable: true });
  return new PlatformError("assistant_compute_rejected", "Assistant compute gateway rejected the request", { status: 502 });
}

function sseRecords(buffer) {
  const records = [];
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) records.push(data);
  }
  return { records, remainder: buffer };
}

export class OpenAiQueuedAnswerRunner {
  #origin;
  #model;
  #token;
  #fetch;

  constructor({ computeGatewayOrigin, model, tokenProvider = async () => null, fetchImplementation = globalThis.fetch }) {
    if (typeof fetchImplementation !== "function") throw new TypeError("Assistant compute fetch implementation is required");
    if (typeof tokenProvider !== "function") throw new TypeError("Assistant compute token provider is required");
    this.#origin = safeOrigin(computeGatewayOrigin);
    this.#model = safeModel(model);
    this.#token = tokenProvider;
    this.#fetch = fetchImplementation;
  }

  async run({ run, history, signal, emit }) {
    const token = await this.#token();
    if (token !== null && (typeof token !== "string" || token.length < 16 || /\s/.test(token))) {
      throw new PlatformError("assistant_compute_credential_invalid", "Assistant compute credential is unavailable", { status: 503 });
    }
    const response = await this.#fetch(`${this.#origin}/v1/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "idempotency-key": `assistant-${run.id}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: this.#model,
        stream: true,
        stream_options: { include_usage: true },
        messages: history
          .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
          .map((message) => ({ role: message.role, content: message.content })),
        x_teamaibox: {
          data_class: "confidential",
          idempotency_key: `assistant-${run.id}`,
          extensions: { client: "official.assistant", conversation_id: run.conversationId },
        },
      }),
    });
    if (!response.ok || !response.body) throw errorFromStatus(response.status);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/event-stream")) {
      throw new PlatformError("assistant_compute_invalid", "Assistant compute stream is invalid", { status: 502 });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let emittedUsage = null;
    while (!done) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done }).replaceAll("\r\n", "\n");
      const parsed = sseRecords(buffer);
      buffer = parsed.remainder;
      for (const record of parsed.records) {
        if (record === "[DONE]") {
          done = true;
          break;
        }
        let value;
        try {
          value = JSON.parse(record);
        } catch {
          throw new PlatformError("assistant_compute_invalid", "Assistant compute stream contained invalid JSON", { status: 502 });
        }
        const delta = value?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) await emit({ type: "text_delta", delta });
        const usage = value?.usage;
        if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
          const normalized = {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            costMicrounits: Number.isSafeInteger(value?.x_teamaibox?.cost_microunits) ? value.x_teamaibox.cost_microunits : 0,
            currency: typeof value?.x_teamaibox?.currency === "string" ? value.x_teamaibox.currency : "CNY",
          };
          const signature = JSON.stringify(normalized);
          if (signature !== emittedUsage) {
            emittedUsage = signature;
            await emit({ type: "usage.updated", usage: normalized });
          }
        }
        for (const source of Array.isArray(value?.x_teamaibox?.sources) ? value.x_teamaibox.sources : []) {
          await emit({ type: "source.cited", source });
        }
        for (const artifact of Array.isArray(value?.x_teamaibox?.artifacts) ? value.x_teamaibox.artifacts : []) {
          await emit({ type: "artifact.created", artifact });
        }
      }
      if (chunk.done) break;
    }
    if (!done) throw new PlatformError("assistant_compute_incomplete", "Assistant compute stream ended before completion", { status: 502, retryable: true });
  }
}

export function fixedAssistantRoutingPolicy({ model, profileKey = null, providerKey = "platform.compute", targetKind = "internal" }) {
  safeModel(model);
  if (profileKey !== null) safeModel(profileKey);
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(providerKey) || !new Set(["internal", "external"]).has(targetKind)) {
    throw new TypeError("Assistant routing disclosure is invalid");
  }
  return ({ requestedMode, content }) => {
    const agentIntent = /(?:\b(?:write|modify|edit|execute|run|install|create|build|code)\b|写入|修改|编辑|执行|运行|安装|创建|编程|代码)/iu.test(content);
    const effectiveMode = requestedMode === "auto" ? (agentIntent ? "agent" : "answer") : requestedMode;
    return {
      effectiveMode,
      targetKind,
      providerKey,
      modelKey: effectiveMode === "answer" ? model : "agent.bridge",
      profileKey,
      reasonKey: requestedMode === "auto"
        ? (agentIntent ? "assistant.routing.agent_intent" : "assistant.routing.answer_intent")
        : "assistant.routing.user_selected",
    };
  };
}
