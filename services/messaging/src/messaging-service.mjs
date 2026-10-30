import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PERMISSIONS = new Set(["message:read", "message:write", "message:manage"]);

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function requireUuid(value, code = "messaging_identity_invalid") {
  if (typeof value !== "string" || !UUID.test(value)) throw new PlatformError(code, "Messaging identity is invalid", { status: 400 });
  return value;
}

function pageCursor(beforeTime, beforeId) {
  if (beforeTime === null && beforeId === null) return;
  if (typeof beforeTime !== 'string' || !Number.isFinite(Date.parse(beforeTime)) || !UUID.test(beforeId ?? '')) {
    throw new PlatformError('messaging_cursor_invalid','Message page cursor is invalid',{status:400});
  }
}

function actor(context, permission) {
  if (!context || typeof context !== "object" || !new Set(["local_user", "service_account"]).has(context.actorKind)
    || !UUID.test(context.actorIdentityId ?? "") || !Array.isArray(context.permissions)
    || context.permissions.some((value) => !PERMISSIONS.has(value)) || !context.permissions.includes(permission)
    || (context.actorKind === "service_account" && (typeof context.applicationKey !== "string" || !KEY.test(context.applicationKey)))) {
    throw new PlatformError("messaging_permission_denied", "Messaging permission is denied", { status: 403 });
  }
  return Object.freeze({
    actorIdentityId: context.actorIdentityId,
    actorKind: context.actorKind,
    applicationKey: context.actorKind === "service_account" ? context.applicationKey : null,
  });
}

function publicConversation(value) {
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    title: value.title,
    teamKey: value.teamKey,
    participants: Object.freeze(value.participants.filter((item) => !item.leftAt).map((item) => Object.freeze({
      identityId: item.identityId,
      role: item.role,
      joinedAt: item.joinedAt.toISOString(),
      lastReadSequence: item.lastReadSequence,
    }))),
    lastMessageSequence: value.lastMessageSequence,
    ...(Number.isSafeInteger(value.unreadCount) ? { unreadCount: value.unreadCount } : {}),
    revision: value.revision,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function publicMessage(value) {
  return Object.freeze({
    id: value.id,
    conversationId: value.conversationId,
    sequence: value.sequence,
    authorIdentityId: value.authorIdentityId,
    authorKind: value.authorKind,
    applicationKey: value.applicationKey,
    content: value.deletedAt ? "" : value.content,
    attachments: Object.freeze((value.deletedAt ? [] : value.attachments).map((item) => Object.freeze(copy(item)))),
    replyToMessageId: value.replyToMessageId,
    delivery: Object.freeze(value.delivery.map((item) => Object.freeze({
      identityId: item.identityId,
      state: item.state,
      deliveredAt: item.deliveredAt?.toISOString() ?? null,
      readAt: item.readAt?.toISOString() ?? null,
    }))),
    createdAt: value.createdAt.toISOString(),
    editedAt: value.editedAt?.toISOString() ?? null,
    deletedAt: value.deletedAt?.toISOString() ?? null,
  });
}

function publicNotification(value) {
  return Object.freeze({
    id: value.id,
    conversationId: value.conversationId,
    messageId: value.messageId,
    kind: value.kind,
    createdAt: value.createdAt.toISOString(),
    readAt: value.readAt?.toISOString() ?? null,
  });
}

function publicEvent(value) {
  return Object.freeze({
    id: value.id,
    sequence: value.sequence,
    type: value.type,
    conversationId: value.conversationId,
    messageId: value.messageId,
    data: Object.freeze(copy(value.data)),
    createdAt: value.createdAt.toISOString(),
  });
}

function publicPresence(value) {
  return Object.freeze({
    identityId: value.identityId,
    state: value.state,
    connectionCount: value.connectionCount,
    lastSeenAt: value.lastSeenAt.toISOString(),
    expiresAt: value.expiresAt?.toISOString() ?? null,
    revision: value.revision,
  });
}

function title(value, kind) {
  if (kind === "direct") {
    if (value !== null && value !== undefined) throw new PlatformError("messaging_conversation_invalid", "Direct conversations cannot have a title", { status: 400 });
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new PlatformError("messaging_conversation_invalid", "Group conversation title is invalid", { status: 400 });
  }
  return value.trim();
}

function conversationParticipants(values, ownerIdentityId, kind) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !UUID.test(value))) {
    throw new PlatformError("messaging_participants_invalid", "Conversation participants are invalid", { status: 400 });
  }
  const participants = [...new Set(values)].sort();
  if (!participants.includes(ownerIdentityId) || (kind === "direct" && participants.length !== 2)
    || (kind === "group" && (participants.length < 2))) {
    throw new PlatformError("messaging_participants_invalid", "Conversation participant count is invalid", { status: 400 });
  }
  return participants;
}

async function attachments(values, verifier, owner) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !UUID.test(value))) {
    throw new PlatformError("messaging_attachment_invalid", "Message attachments are invalid", { status: 400 });
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new PlatformError("messaging_attachment_invalid", "Message attachment is duplicated", { status: 400 });
  const resolved = [];
  for (const referenceId of unique) {
    const value = await verifier.resolveAttachment({
      actorIdentityId: owner.actorIdentityId,
      referenceId,
      audience: "messaging.attachment",
      requiredOperation: "read",
    });
    if (!value || !UUID.test(value.objectId ?? "") || !Number.isSafeInteger(value.objectVersion) || value.objectVersion < 1
      || typeof value.filename !== "string" || !value.filename.trim() || value.filename.length > 1024
      || typeof value.mediaType !== "string" || value.mediaType.length > 256
      || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 || !SHA256.test(value.sha256 ?? "")) {
      throw new PlatformError("messaging_attachment_unavailable", "Message attachment could not be verified", { status: 409 });
    }
    resolved.push(Object.freeze({
      objectId: value.objectId,
      objectVersion: value.objectVersion,
      filename: value.filename,
      mediaType: value.mediaType,
      byteSize: value.byteSize,
      sha256: value.sha256,
    }));
  }
  return resolved;
}

export class MessagingService {
  #repository;
  #attachments;
  #clock;
  #audit;
  #eventSink;

  constructor({ repository, attachmentVerifier, clock = () => new Date(), audit = async () => {}, eventSink = async () => {} }) {
    const methods = [
      "createConversation", "findConversationForMember", "listConversations", "addParticipant",
      "insertMessage", "listMessages", "findAttachmentForMember", "markDelivery", "searchMessages", "listNotifications",
      "markNotificationRead", "setPresence", "getPresence", "listEvents", "findEvent",
    ];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")
      || !attachmentVerifier?.resolveAttachment || !attachmentVerifier?.issueDownloadReference
      || typeof clock !== "function" || typeof audit !== "function" || typeof eventSink !== "function") {
      throw new TypeError("Messaging service dependencies are incomplete");
    }
    this.#repository = repository;
    this.#attachments = attachmentVerifier;
    this.#clock = clock;
    this.#audit = audit;
    this.#eventSink = eventSink;
  }

  async createConversation(context, { kind, title: requestedTitle = null, teamKey = null, participantIdentityIds }) {
    const owner = actor(context, "message:write");
    if (!new Set(["direct", "group"]).has(kind) || (teamKey !== null && (kind !== "group" || typeof teamKey !== "string" || !KEY.test(teamKey)))) {
      throw new PlatformError("messaging_conversation_invalid", "Conversation declaration is invalid", { status: 400 });
    }
    const participantIds = conversationParticipants(participantIdentityIds, owner.actorIdentityId, kind);
    const now = this.#clock();
    const directKey = kind === "direct" ? digest(participantIds) : null;
    const value = {
      id: randomUUID(), kind, title: title(requestedTitle, kind), teamKey, directKey,
      createdByIdentityId: owner.actorIdentityId,
      participants: participantIds.map((identityId) => ({
        identityId,
        role: identityId === owner.actorIdentityId ? "owner" : "member",
        joinedAt: now,
        leftAt: null,
        lastReadSequence: 0,
      })),
      lastMessageSequence: 0, revision: 1, createdAt: now, updatedAt: now,
    };
    const result = await this.#repository.createConversation(value);
    await this.#emit(result.event);
    if (result.inserted) await this.#audit({ action: "messaging.conversation_created", actorIdentityId: owner.actorIdentityId, conversationId: result.conversation.id, kind, participantCount: participantIds.length, occurredAt: now.toISOString() });
    return publicConversation(result.conversation);
  }

  async listConversations(context, { after = 0, limit = 50 } = {}) {
    const owner = actor(context, "message:read");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new PlatformError("messaging_cursor_invalid", "Conversation cursor is invalid", { status: 400 });
    }
    return Object.freeze((await this.#repository.listConversations(owner.actorIdentityId, { after, limit })).map(publicConversation));
  }

  async addParticipant(context, conversationId, { identityId, role = "member" }) {
    const owner = actor(context, "message:manage");
    requireUuid(conversationId, "messaging_conversation_invalid");
    requireUuid(identityId, "messaging_participants_invalid");
    if (!new Set(["admin", "member"]).has(role)) throw new PlatformError("messaging_participants_invalid", "Conversation participant role is invalid", { status: 400 });
    const conversation = await this.#ownedConversation(owner.actorIdentityId, conversationId);
    const membership = conversation.participants.find((value) => value.identityId === owner.actorIdentityId && !value.leftAt);
    if (conversation.kind !== "group" || !new Set(["owner", "admin"]).has(membership.role)) {
      throw new PlatformError("messaging_manage_denied", "Conversation membership cannot be managed", { status: 403 });
    }
    const result = await this.#repository.addParticipant({ conversationId, identityId, role, now: this.#clock(), actorIdentityId: owner.actorIdentityId });
    await this.#emit(result.event);
    return publicConversation(result.conversation);
  }

  async sendMessage(context, conversationId, { idempotencyKey, content = "", attachmentReferenceIds = [], replyToMessageId = null }) {
    const owner = actor(context, "message:write");
    requireUuid(conversationId, "messaging_conversation_invalid");
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY.test(idempotencyKey)
      || typeof content !== "string" || content.includes("\0")
      || (replyToMessageId !== null && (typeof replyToMessageId !== "string" || !UUID.test(replyToMessageId)))) {
      throw new PlatformError("messaging_message_invalid", "Message declaration is invalid", { status: 400 });
    }
    await this.#ownedConversation(owner.actorIdentityId, conversationId);
    const resolvedAttachments = await attachments(attachmentReferenceIds, this.#attachments, owner);
    if (!content.trim() && resolvedAttachments.length === 0) throw new PlatformError("messaging_message_invalid", "Message must contain text or an attachment", { status: 400 });
    const requestDigest = digest({ content, attachments: resolvedAttachments, replyToMessageId });
    const now = this.#clock();
      const result = await this.#repository.insertMessage({
      id: randomUUID(), conversationId, authorIdentityId: owner.actorIdentityId,
      authorKind: owner.actorKind === "service_account" ? "application" : "user",
      applicationKey: owner.applicationKey, idempotencyKey, requestDigest,
      content, attachments: resolvedAttachments, replyToMessageId,
      createdAt: now, editedAt: null, deletedAt: null,
    });
    if (!result) throw new PlatformError("messaging_conversation_not_found", "Conversation is unavailable", { status: 404 });
    if (!result.inserted && result.message.requestDigest !== requestDigest) {
      throw new PlatformError("messaging_idempotency_conflict", "Message idempotency key was reused with different content", { status: 409 });
    }
    await this.#emit(result.event);
    if (result.inserted) await this.#audit({
      action: "messaging.message_sent", actorIdentityId: owner.actorIdentityId,
      actorKind: owner.actorKind, applicationKey: owner.applicationKey,
      conversationId, messageId: result.message.id, attachmentCount: resolvedAttachments.length,
      contentBytes: Buffer.byteLength(content), occurredAt: now.toISOString(),
    });
    return publicMessage(result.message);
  }

  async history(context, conversationId, { after = 0, before = null, limit = 100 } = {}) {
    const owner = actor(context, "message:read");
    requireUuid(conversationId, "messaging_conversation_invalid");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PlatformError("messaging_cursor_invalid", "Message cursor is invalid", { status: 400 });
    if (before !== null && (!Number.isSafeInteger(before) || before < 1 || after !== 0)) throw new PlatformError("messaging_cursor_invalid", "Message cursor is invalid", { status: 400 });
    await this.#ownedConversation(owner.actorIdentityId, conversationId);
    return Object.freeze((await this.#repository.listMessages(conversationId, { after, before, limit, identityId: owner.actorIdentityId })).map(publicMessage));
  }

  async cleanup(context, conversationId, { action, throughSequence = null, messageId = null, confirm = false }) {
    const owner = actor(context, 'message:read');
    requireUuid(conversationId, 'messaging_conversation_invalid');
    if (confirm !== true || !['message', 'clear', 'remove'].includes(action)
      || (action === 'message' ? !UUID.test(messageId ?? '') : !Number.isSafeInteger(throughSequence) || throughSequence < 0)) {
      throw new PlatformError('messaging_cleanup_invalid', 'Cleanup requires confirmation and an exact target', { status: 400 });
    }
    const result = await this.#repository.cleanup({ conversationId, identityId: owner.actorIdentityId, action, throughSequence, messageId, now: this.#clock() });
    if (!result) throw new PlatformError('messaging_conversation_not_found', 'Conversation or message is unavailable', { status: 404 });
    await this.#emit(result.event);
    await this.#audit({ action: 'messaging.personal_cleanup', actorIdentityId: owner.actorIdentityId, conversationId, cleanupAction: action, messageId, throughSequence });
    return Object.freeze({ conversationId, action, messageId, throughSequence, scope: 'self' });
  }

  async attachmentDownload(context, messageId, ordinal, { expiresInSeconds = 300 } = {}) {
    const owner = actor(context, "message:read");
    requireUuid(messageId, "messaging_message_invalid");
    if (!Number.isSafeInteger(ordinal) || ordinal < 1
      || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 600) {
      throw new PlatformError("messaging_attachment_invalid", "Message attachment request is invalid", { status: 400 });
    }
    const attachment = await this.#repository.findAttachmentForMember(messageId, owner.actorIdentityId, ordinal);
    if (!attachment) throw new PlatformError("messaging_attachment_not_found", "Message attachment is unavailable", { status: 404 });
    const reference = await this.#attachments.issueDownloadReference({
      actorIdentityId: owner.actorIdentityId,
      objectId: attachment.objectId,
      objectVersion: attachment.objectVersion,
      expiresInSeconds,
    });
    if (!UUID.test(reference?.referenceId ?? "") || typeof reference?.expiresAt !== "string") {
      throw new PlatformError("messaging_attachment_unavailable", "Message attachment download is unavailable", { status: 503, retryable: true });
    }
    await this.#audit({
      action: "messaging.attachment_download_issued", actorIdentityId: owner.actorIdentityId,
      messageId, objectId: attachment.objectId, objectVersion: attachment.objectVersion,
      occurredAt: this.#clock().toISOString(),
    });
    return Object.freeze({
      referenceId: reference.referenceId,
      expiresAt: reference.expiresAt,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
    });
  }

  async markRead(context, messageId) {
    const owner = actor(context, "message:read");
    requireUuid(messageId, "messaging_message_invalid");
    const result = await this.#repository.markDelivery({ messageId, identityId: owner.actorIdentityId, state: "read", now: this.#clock() });
    if (!result) throw new PlatformError("messaging_message_not_found", "Message is unavailable", { status: 404 });
    await this.#emit(result.event);
    return publicMessage(result.message);
  }

  async search(context, { query, conversationId = null, limit = 50, beforeTime = null, beforeId = null }) {
    const owner = actor(context, "message:read");
    if (typeof query !== "string" || !query.trim() || query.includes("\0")
      || (conversationId !== null && !UUID.test(conversationId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError("messaging_search_invalid", "Message search is invalid", { status: 400 });
    }
    if (conversationId) await this.#ownedConversation(owner.actorIdentityId, conversationId);
    pageCursor(beforeTime,beforeId);
    return Object.freeze((await this.#repository.searchMessages(owner.actorIdentityId, { query: query.trim(), conversationId, limit, beforeTime, beforeId })).map(publicMessage));
  }

  async notifications(context, { unreadOnly = false, limit = 100, beforeTime = null, beforeId = null } = {}) {
    const owner = actor(context, "message:read");
    if (typeof unreadOnly !== "boolean" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PlatformError("messaging_notification_invalid", "Notification query is invalid", { status: 400 });
    pageCursor(beforeTime,beforeId);
    return Object.freeze((await this.#repository.listNotifications(owner.actorIdentityId, { unreadOnly, limit, beforeTime, beforeId })).map(publicNotification));
  }

  async markNotificationRead(context, notificationId) {
    const owner = actor(context, "message:read");
    requireUuid(notificationId, "messaging_notification_invalid");
    const value = await this.#repository.markNotificationRead(notificationId, owner.actorIdentityId, this.#clock());
    if (!value) throw new PlatformError("messaging_notification_not_found", "Notification is unavailable", { status: 404 });
    return publicNotification(value);
  }

  async setPresence(context, { state, connectionId, ttlSeconds = 60 }) {
    const owner = actor(context, "message:read");
    if (!new Set(["online", "away", "offline"]).has(state) || typeof connectionId !== "string" || !UUID.test(connectionId)
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 300) {
      throw new PlatformError("messaging_presence_invalid", "Presence declaration is invalid", { status: 400 });
    }
    return publicPresence(await this.#repository.setPresence({ identityId: owner.actorIdentityId, state, connectionId, ttlSeconds, now: this.#clock() }));
  }

  async presence(context, identityIds) {
    const owner = actor(context, "message:read");
    if (!Array.isArray(identityIds) || identityIds.some((value) => typeof value !== "string" || !UUID.test(value))) throw new PlatformError("messaging_presence_invalid", "Presence query is invalid", { status: 400 });
    return Object.freeze((await this.#repository.getPresence(owner.actorIdentityId, [...new Set(identityIds)], this.#clock())).map(publicPresence));
  }

  async replayEvents(context, { after = 0, limit = 500 } = {}) {
    const owner = actor(context, "message:read");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new PlatformError("messaging_cursor_invalid", "Realtime cursor is invalid", { status: 400 });
    const values = await this.#repository.listEvents(owner.actorIdentityId, { after, limit });
    return Object.freeze({ events: Object.freeze(values.map(publicEvent)), cursor: values.at(-1)?.sequence ?? after, hasMore: values.length === limit });
  }

  async gatewayEvent(authority, eventId) {
    if (authority !== "messaging-outbox.v1") throw new PlatformError("messaging_gateway_denied", "Messaging gateway authority is invalid", { status: 403 });
    requireUuid(eventId, "messaging_event_invalid");
    const value = await this.#repository.findEvent(eventId);
    if (!value) throw new PlatformError("messaging_event_not_found", "Messaging event is unavailable", { status: 404 });
    return Object.freeze({ public: publicEvent(value), audienceIdentityIds: Object.freeze([...value.audienceIdentityIds]), authorIdentityId: value.authorIdentityId ?? null });
  }

  async recordGatewayDelivery(authority, { messageId, identityId }) {
    if (authority !== "messaging-outbox.v1") throw new PlatformError("messaging_gateway_denied", "Messaging gateway authority is invalid", { status: 403 });
    requireUuid(messageId, "messaging_message_invalid");
    requireUuid(identityId);
    const result = await this.#repository.markDelivery({ messageId, identityId, state: "delivered", now: this.#clock() });
    if (result) await this.#emit(result.event);
  }

  async #ownedConversation(identityId, conversationId) {
    const value = await this.#repository.findConversationForMember(conversationId, identityId);
    if (!value) throw new PlatformError("messaging_conversation_not_found", "Conversation is unavailable", { status: 404 });
    return value;
  }

  async #emit(event) {
    if (event) await this.#eventSink({ eventId: event.id, subject: "teamaibox.events.v1.messaging", type: event.type });
  }
}

export const messagingRequestDigest = digest;
export const messagingPublicEvent = publicEvent;
