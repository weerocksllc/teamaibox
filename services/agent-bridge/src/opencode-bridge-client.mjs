import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

import { bufferedMediaBytes, reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function safeOrigin(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Agent Bridge origin must be an HTTP(S) origin");
  }
  return parsed.origin;
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new PlatformError("agent_bridge_identifier_invalid", `Agent Bridge ${name} is invalid`, { status: 400 });
  }
  return value;
}

function safeToken(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\s\0]/.test(value)) {
    throw new PlatformError("agent_bridge_credential_unavailable", "Agent Bridge credential is unavailable", { status: 503 });
  }
  return value;
}

async function boundedText(response, maximum = bufferedMediaBytes()) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge response exceeded its size limit", { status: 502 });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge response exceeded its size limit", { status: 502 });
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function boundedBytes(response, maximum) {
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximum || !response.body) {
    throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact size is invalid", { status: 502 });
  }
  const release = reserveBufferedMedia(declared);
  const content = Buffer.allocUnsafe(declared);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (offset + item.value.byteLength > content.byteLength) {
        content.fill(0);
        throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact exceeded its size limit", { status: 502 });
      }
      content.set(item.value, offset);
      offset += item.value.byteLength;
    }
    if (offset !== declared) {
      content.fill(0);
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact length changed", { status: 502 });
    }
    return content;
  } finally {
    release();
    await reader.cancel().catch(() => {});
  }
}

function fallbackError(status) {
  if (status === 401 || status === 403) return new PlatformError("agent_bridge_authentication_failed", "Agent Bridge authentication failed", { status: 503 });
  if (status === 408 || status === 409 || status === 429) return new PlatformError("agent_bridge_busy", "Agent Bridge is busy", { status: 409, retryable: true });
  if (status >= 500) return new PlatformError("agent_bridge_unavailable", "Agent Bridge is unavailable", { status: 503, retryable: true });
  return new PlatformError("agent_bridge_rejected", "Agent Bridge rejected the request", { status: 502 });
}

async function responseError(response) {
  try {
    const value = JSON.parse(await boundedText(response, 64 * 1024));
    const error = value?.error;
    if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
      && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 4096
      && typeof error.retryable === "boolean") {
      return new PlatformError(error.code, error.message, {
        status: response.status >= 400 && response.status <= 599 ? response.status : 502,
        retryable: error.retryable,
      });
    }
  } catch {
    // Fall back to a bounded generic error without retaining the response body.
  }
  return fallbackError(response.status);
}

function query(value) {
  return encodeURIComponent(value);
}

export class OpenCodeBridgeClient {
  #origin;
  #token;
  #fetch;
  #timeoutMs;

  constructor({ origin, tokenProvider, fetchImplementation = globalThis.fetch, timeoutMs = 30_000 }) {
    if (typeof tokenProvider !== "function" || typeof fetchImplementation !== "function") {
      throw new TypeError("Agent Bridge client dependencies are incomplete");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError("Agent Bridge timeout is invalid");
    this.#origin = safeOrigin(origin);
    this.#token = tokenProvider;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
  }

  async #request(path, { method = "GET", body = null, signal = null, accept = "application/json" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.#timeoutMs);
    timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.#fetch(this.#origin + path, {
        method,
        signal: combined,
        headers: {
          accept,
          authorization: `Bearer ${safeToken(await this.#token())}`,
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw await responseError(response);
      return response;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      if (signal?.aborted) throw new PlatformError("agent_bridge_request_cancelled", "Agent Bridge request was cancelled", { status: 499 });
      if (controller.signal.aborted) throw new PlatformError("agent_bridge_timeout", "Agent Bridge timed out", { status: 504, retryable: true });
      throw new PlatformError("agent_bridge_unavailable", "Agent Bridge could not be reached", { status: 503, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(path, options) {
    const response = await this.#request(path, options);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge response content type is invalid", { status: 502 });
    }
    try {
      return JSON.parse(await boundedText(response));
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge response JSON is invalid", { status: 502 });
    }
  }

  health({ signal = null } = {}) { return this.#json("/v1/health", { signal }); }
  createSession({ title = null, signal = null } = {}) { return this.#json("/v1/sessions", { method: "POST", body: { title }, signal }); }
  getSession({ sessionId, signal = null }) { return this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}`, { signal }); }
  sessionStatus({ signal = null } = {}) { return this.#json("/v1/status", { signal }); }
  prompt({ sessionId, messageId, model, agent = null, parts, signal = null }) {
    return this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}/prompts`, {
      method: "POST", body: { messageId, model, agent, parts }, signal,
    });
  }
  listMessages({ sessionId, signal = null }) { return this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}/messages`, { signal }); }
  async interrupt({ sessionId, signal = null }) {
    const value = await this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}/interrupt`, { method: "POST", body: {}, signal });
    if (typeof value?.interrupted !== "boolean") throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge interrupt response is invalid", { status: 502 });
    return value.interrupted;
  }
  diff({ sessionId, messageId = null, signal = null }) {
    const suffix = messageId === null ? "" : `?messageId=${query(safeId(messageId, "message ID"))}`;
    return this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}/diff${suffix}`, { signal });
  }
  listArtifacts({ sessionId, signal = null }) { return this.#json(`/v1/sessions/${query(safeId(sessionId, "session ID"))}/artifacts`, { signal }); }
  async readWorkspaceFile({ path, signal = null }) {
    if (typeof path !== "string" || !path.startsWith("/workspace/") || path.length > 4096
      || path.includes("\0") || /[\r\n]/.test(path)) {
      throw new PlatformError("agent_workspace_artifact_invalid", "Agent workspace artifact path is invalid", { status: 400 });
    }
    const response = await this.#request("/v1/workspace/artifacts/content", {
      method: "POST", body: { path }, signal, accept: "application/octet-stream",
    });
    const declared = Number(response.headers.get("content-length"));
    const sha256 = response.headers.get("x-teamaibox-content-sha256");
    const encodedName = response.headers.get("x-teamaibox-artifact-name");
    if (!Number.isSafeInteger(declared) || declared < 1
      || !SHA256.test(sha256 ?? "") || typeof encodedName !== "string") {
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact metadata is invalid", { status: 502 });
    }
    const content = await boundedBytes(response, bufferedMediaBytes());
    const filename = decodeURIComponent(encodedName);
    const observed = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== declared || observed !== sha256 || !filename || filename.length > 240 || /[\\/\0\r\n]/.test(filename)) {
      content.fill(0);
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact integrity is invalid", { status: 502 });
    }
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mimeType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) {
      content.fill(0);
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge artifact content type is invalid", { status: 502 });
    }
    return Object.freeze({ content, filename, mimeType, sha256 });
  }
  listQuestions({ signal = null } = {}) { return this.#json("/v1/questions", { signal }); }
  async replyQuestion({ requestId, answers, signal = null }) {
    const value = await this.#json(`/v1/questions/${query(safeId(requestId, "question ID"))}/reply`, { method: "POST", body: { answers }, signal });
    if (typeof value?.replied !== "boolean") throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge question response is invalid", { status: 502 });
    return value.replied;
  }
  async rejectQuestion({ requestId, signal = null }) {
    const value = await this.#json(`/v1/questions/${query(safeId(requestId, "question ID"))}/reject`, { method: "POST", body: {}, signal });
    if (typeof value?.rejected !== "boolean") throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge question response is invalid", { status: 502 });
    return value.rejected;
  }
  listToolConfirmations({ signal = null } = {}) { return this.#json("/v1/confirmations", { signal }); }
  async replyToolConfirmation({ requestId, reply, message = null, signal = null }) {
    const value = await this.#json(`/v1/confirmations/${query(safeId(requestId, "confirmation ID"))}/reply`, { method: "POST", body: { reply, message }, signal });
    if (typeof value?.replied !== "boolean") throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge confirmation response is invalid", { status: 502 });
    return value.replied;
  }

  async *events({ signal = null } = {}) {
    const response = await this.#request("/v1/events", { signal, accept: "text/event-stream" });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
      throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge event stream is invalid", { status: 502 });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done }).replaceAll("\r\n", "\n");
        if (Buffer.byteLength(buffer) > bufferedMediaBytes()) throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge event buffer exceeds available memory", { status: 502 });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const value = JSON.parse(data);
            if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") throw new Error("event invalid");
            yield Object.freeze(structuredClone(value));
          } catch {
            throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge event JSON is invalid", { status: 502 });
          }
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) throw new PlatformError("agent_bridge_protocol_incompatible", "Agent Bridge event stream ended with an incomplete event", { status: 502 });
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
