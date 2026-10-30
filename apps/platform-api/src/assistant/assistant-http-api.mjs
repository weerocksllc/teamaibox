import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_PATH = /^\/api\/v1\/assistant\/conversations\/([0-9a-f-]{36})$/i;
const MESSAGE_PATH = /^\/api\/v1\/assistant\/conversations\/([0-9a-f-]{36})\/messages$/i;
const EVENT_PATH = /^\/api\/v1\/assistant\/conversations\/([0-9a-f-]{36})\/events$/i;
const RUN_CANCEL_PATH = /^\/api\/v1\/assistant\/runs\/([0-9a-f-]{36})\/cancel$/i;
const CONFIRMATION_PATH = /^\/api\/v1\/assistant\/confirmations\/([0-9a-f-]{36})\/decision$/i;
const ARTIFACT_DOWNLOAD_PATH = /^\/api\/v1\/assistant\/artifacts\/([0-9a-f-]{36})\/download$/i;

function matchUuid(pattern, pathname) {
  const match = pattern.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function cursor(query) {
  const raw = query?.get?.("after") ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new PlatformError("assistant_cursor_invalid", "Assistant event cursor is invalid", { status: 400 });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new PlatformError("assistant_cursor_invalid", "Assistant event cursor is invalid", { status: 400 });
  }
  return value;
}

export function matchesAssistantHttpRoute(method, pathname) {
  if (pathname === "/api/v1/assistant/conversations") return method === "GET" || method === "POST";
  if (matchUuid(CONVERSATION_PATH, pathname)) return method === "GET";
  if (matchUuid(MESSAGE_PATH, pathname)) return method === "POST";
  if (matchUuid(EVENT_PATH, pathname)) return method === "GET";
  if (matchUuid(RUN_CANCEL_PATH, pathname)) return method === "POST";
  if (matchUuid(CONFIRMATION_PATH, pathname)) return method === "POST";
  if (matchUuid(ARTIFACT_DOWNLOAD_PATH, pathname)) return method === "GET";
  return false;
}

export class AssistantHttpApi {
  #service;

  constructor({ service }) {
    const required = [
      "createConversation", "listConversations", "getConversation", "submitMessage",
      "cancelRun", "decideConfirmation", "listEvents", "streamEvents", "artifactDownload",
    ];
    if (!service || required.some((method) => typeof service[method] !== "function")) {
      throw new TypeError("assistant service is incomplete");
    }
    this.#service = service;
  }

  matches(method, pathname) {
    return matchesAssistantHttpRoute(method, pathname);
  }

  async handle({ method, pathname, body = null, context, headers = {}, query = new URLSearchParams(), signal }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
    const ownerIdentityId = context.identityId;
    if (pathname === "/api/v1/assistant/conversations" && method === "GET") {
      return { kind: "json", status: 200, body: { object: "list", data: await this.#service.listConversations(ownerIdentityId) } };
    }
    if (pathname === "/api/v1/assistant/conversations" && method === "POST") {
      const conversation = await this.#service.createConversation(ownerIdentityId, { title: body?.title ?? null });
      return { kind: "json", status: 201, body: conversation };
    }
    const conversationId = matchUuid(CONVERSATION_PATH, pathname);
    if (conversationId && method === "GET") {
      return { kind: "json", status: 200, body: await this.#service.getConversation(ownerIdentityId, conversationId) };
    }
    const messageConversationId = matchUuid(MESSAGE_PATH, pathname);
    if (messageConversationId && method === "POST") {
      const rawIdempotency = headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawIdempotency) ? null : rawIdempotency;
      if (!idempotencyKey) {
        throw new PlatformError("assistant_idempotency_required", "Idempotency-Key is required", { status: 400 });
      }
      const result = await this.#service.submitMessage(ownerIdentityId, messageConversationId, {
        content: body?.input,
        mode: body?.mode ?? "auto",
        idempotencyKey,
        inputReferenceIds: body?.input_reference_ids ?? [],
      });
      return { kind: "json", status: result.replayed ? 200 : 202, body: result };
    }
    const eventConversationId = matchUuid(EVENT_PATH, pathname);
    if (eventConversationId && method === "GET") {
      const afterSequence = cursor(query);
      await this.#service.listEvents(ownerIdentityId, eventConversationId, afterSequence);
      return {
        kind: "sse",
        status: 200,
        events: this.#service.streamEvents(ownerIdentityId, eventConversationId, {
          afterSequence,
          once: query.get("once") === "1",
          signal,
        }),
        doneMarker: null,
      };
    }
    const runId = matchUuid(RUN_CANCEL_PATH, pathname);
    if (runId && method === "POST") {
      return { kind: "json", status: 200, body: await this.#service.cancelRun(ownerIdentityId, runId) };
    }
    const confirmationId = matchUuid(CONFIRMATION_PATH, pathname);
    if (confirmationId && method === "POST") {
      return {
        kind: "json",
        status: 200,
        body: await this.#service.decideConfirmation(ownerIdentityId, confirmationId, body?.decision),
      };
    }
    const artifactId = matchUuid(ARTIFACT_DOWNLOAD_PATH, pathname);
    if (artifactId && method === "GET") {
      const reference = await this.#service.artifactDownload(ownerIdentityId, artifactId);
      return {
        kind: "redirect", status: 302, body: null,
        headers: { location: `/api/v1/objects/references/${reference.referenceId}/content?download=1`, "cache-control": "no-store" },
      };
    }
    throw new PlatformError("not_found", "Assistant endpoint was not found", { status: 404 });
  }
}
