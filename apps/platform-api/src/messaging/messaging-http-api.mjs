import { setTimeout as delay } from "node:timers/promises";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const CONVERSATION = new RegExp(`^/api/v1/messaging/conversations/${UUID}/messages$`, "i");
const CLEANUP = new RegExp(`^/api/v1/messaging/conversations/${UUID}/cleanup$`, 'i');
const READ = new RegExp(`^/api/v1/messaging/messages/${UUID}/read$`, "i");
const ATTACHMENT = new RegExp(`^/api/v1/messaging/messages/${UUID}/attachments/([1-9][0-9]*)/download$`, "i");
const NOTIFICATION = new RegExp(`^/api/v1/messaging/notifications/${UUID}/read$`, "i");
const MESSAGE_PERMISSIONS = new Set(["message:read", "message:write", "message:manage"]);

function integer(query, key, fallback, maximum) {
  const raw = query?.get?.(key);
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new PlatformError("messaging_cursor_invalid", "Messaging cursor is invalid", { status: 400 });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new PlatformError("messaging_cursor_invalid", "Messaging cursor is invalid", { status: 400 });
  }
  return value;
}

function boolean(query, key) {
  const raw = query?.get?.(key);
  if (raw === null || raw === undefined || raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new PlatformError("messaging_query_invalid", "Messaging query is invalid", { status: 400 });
}

function actor(context) {
  if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
  return Object.freeze({
    actorIdentityId: context.identityId,
    actorKind: "local_user",
    permissions: Object.freeze((context.permissions ?? []).filter((permission) => MESSAGE_PERMISSIONS.has(permission))),
  });
}

function list(data) {
  return { object: "list", data };
}

function idempotency(headers) {
  const value = headers?.["idempotency-key"];
  if (Array.isArray(value) || typeof value !== "string" || !value) {
    throw new PlatformError("messaging_idempotency_required", "Idempotency-Key is required", { status: 400 });
  }
  return value;
}

async function* durableEvents(service, context, { after, once, signal }) {
  let cursor = after;
  do {
    const replay = await service.replayEvents(context, { after: cursor, limit: 500 });
    for (const event of replay.events) {
      cursor = Math.max(cursor, event.sequence);
      yield { id: String(event.sequence), event: "message", data: event };
    }
    if (once) return;
    try {
      await delay(replay.hasMore ? 0 : 1_000, undefined, { signal });
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }
  } while (!signal?.aborted);
}

export function matchesMessagingHttpRoute(method, pathname) {
  if (CLEANUP.test(pathname)) return method === 'POST';
  if (pathname === "/api/v1/messaging/conversations") return method === "GET" || method === "POST";
  if (CONVERSATION.test(pathname)) return method === "GET" || method === "POST";
  if (pathname === "/api/v1/messaging/events") return method === "GET";
  if (pathname === "/api/v1/messaging/presence") return method === "GET" || method === "POST";
  if (pathname === "/api/v1/messaging/search") return method === "GET";
  if (pathname === "/api/v1/messaging/notifications") return method === "GET";
  if (READ.test(pathname) || NOTIFICATION.test(pathname) || ATTACHMENT.test(pathname)) return method === "POST";
  return false;
}

export class MessagingHttpApi {
  #service;

  constructor({ service }) {
    const required = [
      "createConversation", "listConversations", "sendMessage", "history", "markRead",
      "attachmentDownload", "search", "notifications", "markNotificationRead", "setPresence", "presence", "replayEvents",
    ];
    if (!service || required.some((method) => typeof service[method] !== "function")) {
      throw new TypeError("Messaging HTTP service is incomplete");
    }
    this.#service = service;
  }

  matches(method, pathname) { return matchesMessagingHttpRoute(method, pathname); }

  async handle({ method, pathname, body = null, context, headers = {}, query = new URLSearchParams(), signal }) {
    const messagingContext = actor(context);
    const cleanup = CLEANUP.exec(pathname);
    if (cleanup && method === 'POST') return { kind: 'json', status: 200,
      body: await this.#service.cleanup(messagingContext, cleanup[1], body ?? {}) };
    if (pathname === "/api/v1/messaging/conversations" && method === "GET") {
      return { kind: "json", status: 200, body: list(await this.#service.listConversations(messagingContext, {
        after: integer(query, "after", 0, Number.MAX_SAFE_INTEGER), limit: integer(query, "limit", 50, 200),
      })) };
    }
    if (pathname === "/api/v1/messaging/conversations" && method === "POST") {
      const value = await this.#service.createConversation(messagingContext, {
        kind: body?.kind,
        title: body?.title ?? null,
        teamKey: body?.team_key ?? body?.teamKey ?? null,
        participantIdentityIds: body?.participant_identity_ids ?? body?.participantIdentityIds,
      });
      return { kind: "json", status: 201, body: value };
    }
    const conversation = CONVERSATION.exec(pathname);
    if (conversation && method === "GET") {
      return { kind: "json", status: 200, body: list(await this.#service.history(messagingContext, conversation[1], {
        after: integer(query, "after", 0, Number.MAX_SAFE_INTEGER), before: integer(query, "before", null, Number.MAX_SAFE_INTEGER), limit: integer(query, "limit", 100, 500),
      })) };
    }
    if (conversation && method === "POST") {
      return { kind: "json", status: 201, body: await this.#service.sendMessage(messagingContext, conversation[1], {
        idempotencyKey: idempotency(headers),
        content: body?.content ?? "",
        attachmentReferenceIds: body?.attachment_reference_ids ?? body?.attachmentReferenceIds ?? [],
        replyToMessageId: body?.reply_to_message_id ?? body?.replyToMessageId ?? null,
      }) };
    }
    if (pathname === "/api/v1/messaging/events" && method === "GET") {
      return {
        kind: "sse", status: 200,
        events: durableEvents(this.#service, messagingContext, {
          after: integer(query, "after", 0, Number.MAX_SAFE_INTEGER), once: boolean(query, "once"), signal,
        }),
        doneMarker: null,
      };
    }
    if (pathname === "/api/v1/messaging/presence" && method === "GET") {
      const ids = (query.get("identity_ids") || "").split(",").filter(Boolean);
      return { kind: "json", status: 200, body: list(await this.#service.presence(messagingContext, ids)) };
    }
    if (pathname === "/api/v1/messaging/presence" && method === "POST") {
      return { kind: "json", status: 200, body: await this.#service.setPresence(messagingContext, {
        state: body?.state,
        connectionId: body?.connection_id ?? body?.connectionId,
        ttlSeconds: body?.ttl_seconds ?? body?.ttlSeconds ?? 60,
      }) };
    }
    if (pathname === "/api/v1/messaging/search" && method === "GET") {
      return { kind: "json", status: 200, body: list(await this.#service.search(messagingContext, {
        query: query.get("q"), conversationId: query.get("conversation_id") || null,
        beforeTime: query.get('before_time'), beforeId: query.get('before_id'),
        limit: integer(query, "limit", 50, 100),
      })) };
    }
    if (pathname === "/api/v1/messaging/notifications" && method === "GET") {
      return { kind: "json", status: 200, body: list(await this.#service.notifications(messagingContext, {
        unreadOnly: boolean(query, "unread_only"), limit: integer(query, "limit", 100, 500),
        beforeTime: query.get('before_time'), beforeId: query.get('before_id'),
      })) };
    }
    const read = READ.exec(pathname);
    if (read && method === "POST") return { kind: "json", status: 200, body: await this.#service.markRead(messagingContext, read[1]) };
    const attachment = ATTACHMENT.exec(pathname);
    if (attachment && method === "POST") return { kind: "json", status: 201, body: await this.#service.attachmentDownload(
      messagingContext, attachment[1], Number(attachment[2]), { expiresInSeconds: 300 },
    ) };
    const notification = NOTIFICATION.exec(pathname);
    if (notification && method === "POST") return { kind: "json", status: 200, body: await this.#service.markNotificationRead(messagingContext, notification[1]) };
    throw new PlatformError("not_found", "Messaging endpoint was not found", { status: 404 });
  }
}
