import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { bufferedMediaBytes, bufferedMediaResponse, reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SUPPORTED_VERSION = "1.18.16";
const SUPPORTED_DIGEST = "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41";

function safeOrigin(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("OpenCode origin must be an HTTP(S) origin without credentials or paths");
  }
  return parsed.origin;
}

function safeDirectory(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.length > 4096
    || value.includes("\0") || /[\r\n]/.test(value) || value.split("/").includes("..")) {
    throw new PlatformError("opencode_workspace_invalid", "OpenCode workspace directory is invalid", { status: 400 });
  }
  return value.replace(/\/+$/, "") || "/";
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new PlatformError("opencode_identifier_invalid", `OpenCode ${name} is invalid`, { status: 400 });
  }
  return value;
}

function safeText(value, name, maximum = Infinity) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new PlatformError("opencode_input_invalid", `OpenCode ${name} is invalid`, { status: 400 });
  }
  return value;
}

function compatibilityError(message) {
  return new PlatformError("opencode_protocol_incompatible", message, { status: 502 });
}

function statusError(status) {
  if (status === 401 || status === 403) {
    return new PlatformError("opencode_authentication_failed", "OpenCode sandbox authentication failed", { status: 503 });
  }
  if (status === 404 || status === 405) return compatibilityError("Pinned OpenCode endpoint is unavailable");
  if (status === 408 || status === 409 || status === 429) {
    return new PlatformError("opencode_busy", "OpenCode sandbox is busy", { status: 409, retryable: true });
  }
  if (status >= 500) {
    return new PlatformError("opencode_unavailable", "OpenCode sandbox is unavailable", { status: 503, retryable: true });
  }
  return new PlatformError("opencode_rejected", "OpenCode rejected the bridge request", { status: 502 });
}

async function boundedText(response, maximum = bufferedMediaBytes()) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw compatibilityError("OpenCode response exceeded its size limit");
  const bytes = await bufferedMediaResponse(response);
  try { return bytes.toString("utf8"); } finally { bytes.fill(0); }
}

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw compatibilityError(message);
  return value;
}

function requireArray(value, message) {
  if (!Array.isArray(value)) throw compatibilityError(message);
  return value;
}

function validatePromptParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new PlatformError("opencode_prompt_invalid", "OpenCode prompt parts are invalid", { status: 400 });
  }
  for (const part of parts) {
    requireObject(part, "OpenCode prompt part is invalid");
    if (part.type === "text") safeText(part.text, "prompt text");
    else if (part.type === "file") {
      safeText(part.url, "file URL", 8192);
      safeText(part.mime, "file MIME", 256);
      if (part.filename !== undefined) safeText(part.filename, "file name", 1024);
    } else {
      throw new PlatformError("opencode_prompt_invalid", "OpenCode prompt part type is not allowed by the bridge", { status: 400 });
    }
  }
  const release = reserveBufferedMedia(Buffer.byteLength(JSON.stringify(parts)));
  try { return structuredClone(parts); } finally { release(); }
}

function normalizeArtifacts(messages) {
  const artifacts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const candidates = part?.type === "file"
        ? [part]
        : part?.type === "tool" && part.state?.status === "completed" && Array.isArray(part.state.attachments)
          ? part.state.attachments
          : [];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate.url !== "string" || typeof candidate.mime !== "string") continue;
        artifacts.push(Object.freeze({
          messageId: String(message.info?.id ?? candidate.messageID ?? ""),
          partId: String(candidate.id ?? ""),
          filename: typeof candidate.filename === "string" ? candidate.filename : null,
          mime: candidate.mime,
          sourceLocator: candidate.url,
        }));
      }
    }
  }
  return Object.freeze(artifacts);
}

export class OpenCodeV118Adapter {
  #origin;
  #credentials;
  #fetch;
  #timeoutMs;

  constructor({ origin, credentialProvider, fetchImplementation = globalThis.fetch, timeoutMs = 15_000 }) {
    if (typeof credentialProvider !== "function") throw new TypeError("OpenCode credential provider is required");
    if (typeof fetchImplementation !== "function") throw new TypeError("OpenCode fetch implementation is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError("OpenCode timeout is invalid");
    this.#origin = safeOrigin(origin);
    this.#credentials = credentialProvider;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
  }

  get compatibility() {
    return Object.freeze({ adapterKey: "opencode.http.v1.18", version: SUPPORTED_VERSION, artifactDigest: SUPPORTED_DIGEST });
  }

  async #authorization() {
    const value = await this.#credentials();
    if (!value || typeof value.username !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.username)
      || typeof value.password !== "string" || value.password.length < 32 || value.password.length > 4096
      || /[\r\n\0]/.test(value.password)) {
      throw new PlatformError("opencode_credential_unavailable", "OpenCode sandbox credential is unavailable", { status: 503 });
    }
    return `Basic ${Buffer.from(`${value.username}:${value.password}`).toString("base64")}`;
  }

  async #request(path, { method = "GET", directory = null, body = null, signal = null, accept = "application/json" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.#timeoutMs);
    timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        signal: combined,
        headers: {
          accept,
          authorization: await this.#authorization(),
          ...(directory ? { "x-opencode-directory": safeDirectory(directory) } : {}),
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw statusError(response.status);
      return response;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      if (signal?.aborted) throw new PlatformError("opencode_request_cancelled", "OpenCode request was cancelled", { status: 499 });
      if (controller.signal.aborted) throw new PlatformError("opencode_timeout", "OpenCode sandbox timed out", { status: 504, retryable: true });
      throw new PlatformError("opencode_unavailable", "OpenCode sandbox could not be reached", { status: 503, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(path, options) {
    const response = await this.#request(path, options);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw compatibilityError("OpenCode response content type is invalid");
    }
    const text = await boundedText(response);
    try {
      return JSON.parse(text);
    } catch {
      throw compatibilityError("OpenCode response JSON is invalid");
    }
  }

  async health({ signal = null } = {}) {
    const value = requireObject(await this.#json("/global/health", { signal }), "OpenCode health response is invalid");
    if (value.healthy !== true || value.version !== SUPPORTED_VERSION) {
      throw compatibilityError("OpenCode health version does not match the pinned adapter");
    }
    return Object.freeze({ healthy: true, version: value.version, adapterKey: "opencode.http.v1.18" });
  }

  async createSession({ directory, title = null, signal = null } = {}) {
    if (title !== null) safeText(title, "session title", 160);
    const value = requireObject(await this.#json("/session", {
      method: "POST", directory, signal, body: title === null ? {} : { title },
    }), "OpenCode session response is invalid");
    safeId(value.id, "session ID");
    return structuredClone(value);
  }

  async getSession({ directory, sessionId, signal = null }) {
    return structuredClone(requireObject(await this.#json(`/session/${safeId(sessionId, "session ID")}`, {
      directory, signal,
    }), "OpenCode session response is invalid"));
  }

  async sessionStatus({ directory, signal = null }) {
    return structuredClone(requireObject(await this.#json("/session/status", { directory, signal }), "OpenCode status response is invalid"));
  }

  async prompt({ directory, sessionId, messageId, model, agent = null, parts, signal = null }) {
    const payload = {
      messageID: safeId(messageId, "message ID"),
      model: {
        providerID: safeText(model?.providerId, "provider ID", 256),
        modelID: safeText(model?.modelId, "model ID", 512),
      },
      parts: validatePromptParts(parts),
      ...(agent === null ? {} : { agent: safeText(agent, "agent name", 128) }),
    };
    return structuredClone(requireObject(await this.#json(`/session/${safeId(sessionId, "session ID")}/message`, {
      method: "POST", directory, signal, body: payload,
    }), "OpenCode prompt response is invalid"));
  }

  async listMessages({ directory, sessionId, signal = null }) {
    return structuredClone(requireArray(await this.#json(`/session/${safeId(sessionId, "session ID")}/message`, {
      directory, signal,
    }), "OpenCode message response is invalid"));
  }

  async interrupt({ directory, sessionId, signal = null }) {
    const value = await this.#json(`/session/${safeId(sessionId, "session ID")}/abort`, { method: "POST", directory, signal });
    if (typeof value !== "boolean") throw compatibilityError("OpenCode interrupt response is invalid");
    return value;
  }

  async diff({ directory, sessionId, messageId = null, signal = null }) {
    const query = messageId === null ? "" : `?messageID=${encodeURIComponent(safeId(messageId, "message ID"))}`;
    return structuredClone(requireArray(await this.#json(`/session/${safeId(sessionId, "session ID")}/diff${query}`, {
      directory, signal,
    }), "OpenCode diff response is invalid"));
  }

  async listArtifacts(input) {
    return normalizeArtifacts(await this.listMessages(input));
  }

  async listQuestions({ directory, signal = null }) {
    return structuredClone(requireArray(await this.#json("/question", { directory, signal }), "OpenCode question response is invalid"));
  }

  async replyQuestion({ directory, requestId, answers, signal = null }) {
    if (!Array.isArray(answers) || answers.length === 0 || answers.some((answer) => !Array.isArray(answer)
      || answer.length === 0 || answer.some((value) => typeof value !== "string" || !value.trim() || value.length > 1000))) {
      throw new PlatformError("opencode_question_invalid", "OpenCode question answer is invalid", { status: 400 });
    }
    const value = await this.#json(`/question/${safeId(requestId, "question request ID")}/reply`, {
      method: "POST", directory, signal, body: { answers },
    });
    if (typeof value !== "boolean") throw compatibilityError("OpenCode question response is invalid");
    return value;
  }

  async rejectQuestion({ directory, requestId, signal = null }) {
    const value = await this.#json(`/question/${safeId(requestId, "question request ID")}/reject`, {
      method: "POST", directory, signal,
    });
    if (typeof value !== "boolean") throw compatibilityError("OpenCode question response is invalid");
    return value;
  }

  async listToolConfirmations({ directory, signal = null }) {
    return structuredClone(requireArray(await this.#json("/permission", { directory, signal }), "OpenCode permission response is invalid"));
  }

  async replyToolConfirmation({ directory, requestId, reply, message = null, signal = null }) {
    if (!new Set(["once", "always", "reject"]).has(reply) || (message !== null
      && (typeof message !== "string" || message.length > 2000 || message.includes("\0")))) {
      throw new PlatformError("opencode_confirmation_invalid", "OpenCode tool confirmation reply is invalid", { status: 400 });
    }
    const value = await this.#json(`/permission/${safeId(requestId, "permission request ID")}/reply`, {
      method: "POST", directory, signal, body: { reply, ...(message === null ? {} : { message }) },
    });
    if (typeof value !== "boolean") throw compatibilityError("OpenCode permission response is invalid");
    return value;
  }

  async *events({ directory, signal = null }) {
    const response = await this.#request("/event", { directory, signal, accept: "text/event-stream" });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
      throw compatibilityError("OpenCode event stream is invalid");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ordinal = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done }).replaceAll("\r\n", "\n");
        if (Buffer.byteLength(buffer) > bufferedMediaBytes()) throw compatibilityError("OpenCode event stream exceeds available memory");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n");
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let value;
          try {
            value = JSON.parse(data);
          } catch {
            throw compatibilityError("OpenCode event JSON is invalid");
          }
          requireObject(value, "OpenCode event is invalid");
          if (typeof value.type !== "string" || !value.type || value.type.length > 256) throw compatibilityError("OpenCode event type is invalid");
          ordinal += 1;
          const eventId = lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || null;
          yield Object.freeze({ adapterKey: "opencode.http.v1.18", connectionOrdinal: ordinal, upstreamEventId: eventId, type: value.type, event: structuredClone(value) });
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) throw compatibilityError("OpenCode event stream ended with an incomplete event");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

export const OPEN_CODE_V118_COMPATIBILITY = Object.freeze({
  adapterKey: "opencode.http.v1.18",
  version: SUPPORTED_VERSION,
  artifactDigest: SUPPORTED_DIGEST,
});
