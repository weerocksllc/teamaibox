import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { basename, extname, relative, resolve, sep } from "node:path";

import {
  PlatformError,
  correlationIdFromRequest,
  errorResponse,
  runWithCorrelation,
} from "../../../packages/observability/src/index.mjs";

import { bufferedMediaResponse, reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";
const BEARER = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/;
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)$/;
const SESSION_OPERATION_PATH = /^\/v1\/sessions\/([^/]+)\/(prompts|messages|interrupt|diff|artifacts)$/;
const QUESTION_PATH = /^\/v1\/questions\/([^/]+)\/(reply|reject)$/;
const CONFIRMATION_PATH = /^\/v1\/confirmations\/([^/]+)\/reply$/;
const WORKSPACE_ARTIFACT_PATH = "/v1/workspace/artifacts/content";

const ARTIFACT_MIME = Object.freeze({
  ".css": "text/css", ".csv": "text/csv", ".html": "text/html", ".js": "text/javascript",
  ".json": "application/json", ".md": "text/markdown", ".mjs": "text/javascript",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".ts": "text/plain",
  ".tsx": "text/plain", ".txt": "text/plain", ".yaml": "application/yaml", ".yml": "application/yaml",
});

function responseHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...responseHeaders("application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function bytes(response, value) {
  response.writeHead(200, {
    ...responseHeaders(value.mimeType),
    "content-length": value.content.byteLength,
    "x-teamaibox-artifact-name": encodeURIComponent(value.filename),
    "x-teamaibox-content-sha256": value.sha256,
  });
  response.end(value.content);
}

function methodNotAllowed(response, allowed) {
  response.setHeader("allow", allowed.join(", "));
  throw new PlatformError("agent_bridge_method_not_allowed", "Agent Bridge method is not allowed", { status: 405 });
}

function safeWorkspace(value) {
  if (typeof value !== "string" || value !== "/workspace") {
    throw new TypeError("Agent Bridge workspace must be the isolated /workspace root");
  }
  return value;
}

export async function readWorkspaceArtifact({ workspace, path }) {
  if (typeof workspace !== "string" || !workspace.startsWith("/") || typeof path !== "string"
    || !path.startsWith(`${workspace}/`) || path.length > 4096 || path.includes("\0") || /[\r\n]/.test(path)) {
    throw new PlatformError("agent_workspace_artifact_invalid", "Agent workspace artifact path is invalid", { status: 400 });
  }
  const scoped = relative(workspace, resolve(path));
  if (!scoped || scoped.startsWith(`..${sep}`) || scoped === ".." || scoped.split(sep).some((part) => part.startsWith("."))) {
    throw new PlatformError("agent_workspace_artifact_denied", "Agent workspace artifact path is not exportable", { status: 403 });
  }
  const workspaceRoot = await realpath(workspace);
  const candidate = resolve(workspace, scoped);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${sep}`))) {
    throw new PlatformError("agent_workspace_artifact_denied", "Agent workspace artifact escapes the sandbox workspace", { status: 403 });
  }
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new PlatformError("agent_workspace_artifact_unavailable", "Agent workspace artifact is unavailable", { status: 404 });
  let release;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) {
      throw new PlatformError("agent_workspace_artifact_size_invalid", "Agent workspace artifact size is outside the export limit", { status: 413 });
    }
    release = reserveBufferedMedia(stat.size);
    const content = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const item = await handle.read(content, offset, content.byteLength - offset, offset);
      if (item.bytesRead === 0) break;
      offset += item.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, content.byteLength);
    overflow.fill(0);
    if (offset !== stat.size || extra.bytesRead !== 0) {
      content.fill(0);
      throw new PlatformError("agent_workspace_artifact_changed", "Agent workspace artifact changed during export", { status: 409, retryable: true });
    }
    const filename = basename(resolved).normalize("NFC");
    return Object.freeze({
      content,
      filename,
      mimeType: ARTIFACT_MIME[extname(filename).toLowerCase()] ?? "application/octet-stream",
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    release?.();
    await handle.close();
  }
}

function safeToken(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\s\0]/.test(value)) {
    throw new PlatformError("agent_bridge_credential_unavailable", "Agent Bridge credential is unavailable", { status: 503 });
  }
  return value;
}

function sameToken(left, right) {
  const provided = Buffer.from(left);
  const expected = Buffer.from(right);
  try {
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  } finally {
    provided.fill(0);
    expected.fill(0);
  }
}

async function authenticate(request, tokenProvider) {
  const matched = BEARER.exec(request.headers.authorization ?? "");
  const expected = safeToken(await tokenProvider());
  if (!matched || !sameToken(matched[1], expected)) {
    throw new PlatformError("agent_bridge_authentication_failed", "Agent Bridge authentication failed", { status: 401 });
  }
}

async function requestBody(request) {
  const content = await bufferedMediaResponse({
    headers: new Headers(request.headers["content-length"] ? { "content-length": request.headers["content-length"] } : {}),
    body: request,
  });
  try {
    if (content.length === 0) return {};
    const value = JSON.parse(content.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new PlatformError("agent_bridge_json_invalid", "Agent Bridge request JSON is invalid", { status: 400 });
  } finally {
    content.fill(0);
  }
}

function safePathId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PlatformError("agent_bridge_path_invalid", "Agent Bridge request path is invalid", { status: 400 });
  }
}

async function writeEvent(response, event) {
  const id = event.upstreamEventId ?? String(event.connectionOrdinal);
  const record = `id: ${String(id).replace(/[\r\n]/g, "")}\nevent: opencode.event\ndata: ${JSON.stringify(event)}\n\n`;
  if (!response.write(record)) await once(response, "drain");
}

async function route({ request, response, adapter, workspace, workspaceReader }) {
  const url = new URL(request.url ?? "/", "http://agent-bridge.invalid");
  if (url.pathname === "/healthz") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    const upstream = await adapter.health();
    return json(response, 200, { status: "ok", upstream });
  }
  if (url.pathname === "/v1/health") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    return json(response, 200, await adapter.health());
  }
  if (url.pathname === "/v1/sessions") {
    if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
    const body = await requestBody(request);
    return json(response, 201, await adapter.createSession({ workspace, directory: workspace, title: body.title ?? null }));
  }
  if (url.pathname === "/v1/status") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    return json(response, 200, await adapter.sessionStatus({ directory: workspace }));
  }
  if (url.pathname === "/v1/questions") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    return json(response, 200, await adapter.listQuestions({ directory: workspace }));
  }
  if (url.pathname === "/v1/confirmations") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    return json(response, 200, await adapter.listToolConfirmations({ directory: workspace }));
  }
  if (url.pathname === "/v1/events") {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    const controller = new AbortController();
    const abort = () => controller.abort("downstream_closed");
    request.once("aborted", abort);
    response.once("close", abort);
    response.writeHead(200, {
      ...responseHeaders("text/event-stream; charset=utf-8"),
      connection: "keep-alive",
    });
    try {
      for await (const event of adapter.events({ directory: workspace, signal: controller.signal })) {
        await writeEvent(response, event);
      }
      response.end();
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
    return;
  }
  if (url.pathname === WORKSPACE_ARTIFACT_PATH) {
    if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
    const body = await requestBody(request);
    return bytes(response, await workspaceReader({ workspace, path: body.path }));
  }

  const session = SESSION_PATH.exec(url.pathname);
  if (session) {
    if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
    return json(response, 200, await adapter.getSession({ directory: workspace, sessionId: safePathId(session[1]) }));
  }
  const operation = SESSION_OPERATION_PATH.exec(url.pathname);
  if (operation) {
    const sessionId = safePathId(operation[1]);
    if (operation[2] === "prompts") {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      const body = await requestBody(request);
      return json(response, 200, await adapter.prompt({
        directory: workspace, sessionId, messageId: body.messageId,
        model: body.model, agent: body.agent ?? null, parts: body.parts,
      }));
    }
    if (operation[2] === "messages") {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      return json(response, 200, await adapter.listMessages({ directory: workspace, sessionId }));
    }
    if (operation[2] === "interrupt") {
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      return json(response, 200, { interrupted: await adapter.interrupt({ directory: workspace, sessionId }) });
    }
    if (operation[2] === "diff") {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      return json(response, 200, await adapter.diff({ directory: workspace, sessionId, messageId: url.searchParams.get("messageId") }));
    }
    if (operation[2] === "artifacts") {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      return json(response, 200, await adapter.listArtifacts({ directory: workspace, sessionId }));
    }
  }
  const question = QUESTION_PATH.exec(url.pathname);
  if (question) {
    const requestId = safePathId(question[1]);
    if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
    if (question[2] === "reject") {
      return json(response, 200, { rejected: await adapter.rejectQuestion({ directory: workspace, requestId }) });
    }
    const body = await requestBody(request);
    return json(response, 200, { replied: await adapter.replyQuestion({ directory: workspace, requestId, answers: body.answers }) });
  }
  const confirmation = CONFIRMATION_PATH.exec(url.pathname);
  if (confirmation) {
    if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
    const body = await requestBody(request);
    return json(response, 200, { replied: await adapter.replyToolConfirmation({
      directory: workspace, requestId: safePathId(confirmation[1]), reply: body.reply, message: body.message ?? null,
    }) });
  }
  throw new PlatformError("agent_bridge_route_not_found", "Agent Bridge route was not found", { status: 404 });
}

export function createOpenCodeBridgeHttpServer({
  adapter,
  tokenProvider,
  workspace = "/workspace",
  workspaceReader = readWorkspaceArtifact,
}) {
  const methods = [
    "health", "createSession", "getSession", "sessionStatus", "prompt", "listMessages", "interrupt", "diff",
    "listArtifacts", "listQuestions", "replyQuestion", "rejectQuestion", "listToolConfirmations",
    "replyToolConfirmation", "events",
  ];
  if (!adapter || methods.some((method) => typeof adapter[method] !== "function")) throw new TypeError("Agent Bridge adapter is incomplete");
  if (typeof tokenProvider !== "function") throw new TypeError("Agent Bridge token provider is required");
  if (typeof workspaceReader !== "function") throw new TypeError("Agent Bridge workspace reader is required");
  const directory = safeWorkspace(workspace);
  return http.createServer((request, response) => {
    const correlationId = correlationIdFromRequest(request);
    void runWithCorrelation(correlationId, async () => {
      try {
        if (new URL(request.url ?? "/", "http://agent-bridge.invalid").pathname !== "/healthz") {
          await authenticate(request, tokenProvider);
        }
        await route({ request, response, adapter, workspace: directory, workspaceReader });
      } catch (error) {
        if (response.headersSent) {
          if (!response.writableEnded) response.destroy();
          return;
        }
        const value = errorResponse(error, correlationId);
        response.setHeader("x-correlation-id", correlationId);
        json(response, value.status, value.body);
      }
    });
  });
}
