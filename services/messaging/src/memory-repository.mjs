import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

const DELIVERY_ORDER = Object.freeze({ queued: 0, delivered: 1, read: 2 });

export class MemoryMessagingRepository {
  #conversations = new Map();
  #direct = new Map();
  #messages = new Map();
  #messageIds = new Map();
  #idempotency = new Map();
  #notifications = new Map();
  #events = [];
  #presence = new Map();
  #presenceConnections = new Map();
  #hiddenMessages = new Set();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  #audience(conversation) {
    return conversation.participants.filter((value) => !value.leftAt).map((value) => value.identityId).sort();
  }

  #visible(message, identityId) {
    if (!message) return false;
    if (!identityId) return true;
    const member = this.#conversations.get(message.conversationId)?.participants.find(p => p.identityId === identityId && !p.leftAt);
    return !!member && message.sequence > (member.clearedThroughSequence ?? 0)
      && !this.#hiddenMessages.has(`${identityId}:${message.id}`);
  }

  #event({ type, conversation = null, message = null, data = {}, audienceIdentityIds = null, authorIdentityId = null, now }) {
    const value = {
      id: randomUUID(), sequence: this.#events.length + 1, type,
      conversationId: conversation?.id ?? null, messageId: message?.id ?? null,
      audienceIdentityIds: audienceIdentityIds ?? (conversation ? this.#audience(conversation) : []),
      authorIdentityId, data: copy(data), createdAt: new Date(now),
    };
    this.#events.push(value);
    return value;
  }

  async createConversation(value) {
    return this.#exclusive(async () => {
      if (value.directKey && this.#direct.has(value.directKey)) {
        const existing = this.#conversations.get(this.#direct.get(value.directKey));
        const member = existing.participants.find(p => p.identityId === value.createdByIdentityId);
        member.removedThroughSequence = null;
        return { inserted: false, conversation: copy(existing), event: null };
      }
      const conversation = copy(value);
      this.#conversations.set(conversation.id, conversation);
      this.#messages.set(conversation.id, []);
      if (conversation.directKey) this.#direct.set(conversation.directKey, conversation.id);
      const event = this.#event({ type: "conversation.created", conversation, data: { kind: conversation.kind }, authorIdentityId: conversation.createdByIdentityId, now: conversation.createdAt });
      return { inserted: true, conversation: copy(conversation), event: copy(event) };
    });
  }

  async findConversationForMember(conversationId, identityId) {
    const value = this.#conversations.get(conversationId);
    return copy(value?.participants.some((participant) => participant.identityId === identityId && !participant.leftAt) ? value : null);
  }

  async listConversations(identityId, { after, limit }) {
    return [...this.#conversations.values()]
      .filter((value) => value.participants.some((p) => p.identityId === identityId && !p.leftAt
        && (p.removedThroughSequence == null || value.lastMessageSequence > p.removedThroughSequence)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(after, after + limit).map(value => ({ ...copy(value), unreadCount: (this.#messages.get(value.id) ?? []).filter(m => this.#visible(m, identityId)
        && m.sequence > value.participants.find(p => p.identityId === identityId).lastReadSequence).length }));
  }

  async addParticipant({ conversationId, identityId, role, now, actorIdentityId }) {
    return this.#exclusive(async () => {
      const conversation = this.#conversations.get(conversationId);
      if (!conversation) return null;
      const existing = conversation.participants.find((value) => value.identityId === identityId);
      if (existing && !existing.leftAt) return { conversation: copy(conversation), event: null };
      if (existing) Object.assign(existing, { role, joinedAt: now, leftAt: null, lastReadSequence: 0 });
      else conversation.participants.push({ identityId, role, joinedAt: now, leftAt: null, lastReadSequence: 0 });
      conversation.revision += 1;
      conversation.updatedAt = now;
      const event = this.#event({ type: "conversation.participant_added", conversation, data: { identityId, role }, authorIdentityId: actorIdentityId, now });
      return { conversation: copy(conversation), event: copy(event) };
    });
  }

  async insertMessage(value) {
    return this.#exclusive(async () => {
      const conversation = this.#conversations.get(value.conversationId);
      if (!conversation?.participants.some((participant) => participant.identityId === value.authorIdentityId && !participant.leftAt)) return null;
      const key = `${value.conversationId}\0${value.authorIdentityId}\0${value.idempotencyKey}`;
      const existingId = this.#idempotency.get(key);
      if (existingId) return { inserted: false, message: copy(this.#messageIds.get(existingId)), event: null };
      const reply = value.replyToMessageId ? this.#messageIds.get(value.replyToMessageId) : null;
      if (value.replyToMessageId && (!reply || reply.conversationId !== value.conversationId)) throw new PlatformError("messaging_reply_invalid", "Reply target is unavailable", { status: 409 });
      conversation.lastMessageSequence += 1;
      conversation.revision += 1;
      conversation.updatedAt = value.createdAt;
      const message = {
        ...copy(value), sequence: conversation.lastMessageSequence,
        delivery: this.#audience(conversation).map((identityId) => ({
          identityId,
          state: identityId === value.authorIdentityId ? "read" : "queued",
          deliveredAt: identityId === value.authorIdentityId ? value.createdAt : null,
          readAt: identityId === value.authorIdentityId ? value.createdAt : null,
        })),
      };
      this.#messages.get(conversation.id).push(message);
      this.#messageIds.set(message.id, message);
      this.#idempotency.set(key, message.id);
      for (const participant of conversation.participants) {
        if (participant.leftAt || participant.identityId === value.authorIdentityId) continue;
        const notification = { id: randomUUID(), identityId: participant.identityId, conversationId: conversation.id, messageId: message.id, kind: "message", createdAt: value.createdAt, readAt: null };
        this.#notifications.set(notification.id, notification);
      }
      const event = this.#event({ type: "message.created", conversation, message, data: { sequence: message.sequence, authorIdentityId: message.authorIdentityId }, authorIdentityId: message.authorIdentityId, now: message.createdAt });
      return { inserted: true, message: copy(message), event: copy(event) };
    });
  }

  async listMessages(conversationId, { after, before = null, limit, identityId }) {
    const messages = (this.#messages.get(conversationId) ?? []).filter(m => this.#visible(m, identityId));
    return (before === null ? messages.filter(value => value.sequence > after).slice(0, limit)
      : messages.filter(value => value.sequence < before).slice(-limit)).map(copy);
  }

  async findAttachmentForMember(messageId, identityId, ordinal) {
    const message = this.#messageIds.get(messageId);
    const conversation = message ? this.#conversations.get(message.conversationId) : null;
    const member = conversation?.participants.some((value) => value.identityId === identityId && !value.leftAt);
    if (!message || message.deletedAt || !member || !this.#visible(message, identityId)) return null;
    return copy(message.attachments[ordinal - 1] ?? null);
  }

  async markDelivery({ messageId, identityId, state, now }) {
    return this.#exclusive(async () => {
      const message = this.#messageIds.get(messageId);
      const receipt = message?.delivery.find((value) => value.identityId === identityId);
      const conversation = message && this.#conversations.get(message.conversationId);
      const participant = conversation?.participants.find((value) => value.identityId === identityId && !value.leftAt);
      if (!message || !receipt || !participant) return null;
      const cursorAdvanced = state === "read" && participant.lastReadSequence < message.sequence;
      if (state === "read") {
        participant.lastReadSequence = Math.max(participant.lastReadSequence, message.sequence);
        for (const notification of this.#notifications.values()) {
          if (notification.identityId === identityId && notification.conversationId === conversation.id
            && this.#messageIds.get(notification.messageId)?.sequence <= message.sequence) notification.readAt ??= now;
        }
      }
      // Own messages already have a read receipt, but opening their history
      // must still advance the conversation cursor past earlier unread items.
      if (DELIVERY_ORDER[state] <= DELIVERY_ORDER[receipt.state] && !cursorAdvanced) return { message: copy(message), event: null };
      if (DELIVERY_ORDER[state] > DELIVERY_ORDER[receipt.state]) {
        receipt.state = state;
        receipt.deliveredAt ??= now;
        if (state === "read") receipt.readAt = now;
      }
      const event = this.#event({ type: `message.${state}`, conversation, message, data: { identityId, sequence: message.sequence }, authorIdentityId: identityId, now });
      return { message: copy(message), event: copy(event) };
    });
  }

  async searchMessages(identityId, { query, conversationId, limit, beforeTime = null, beforeId = null }) {
    const needle = query.toLocaleLowerCase();
    const allowed = new Set([...this.#conversations.values()].filter((conversation) => conversation.participants.some((participant) => participant.identityId === identityId && !participant.leftAt)).map((value) => value.id));
    return [...this.#messageIds.values()]
      .filter((message) => !message.deletedAt && this.#visible(message, identityId) && allowed.has(message.conversationId) && (!conversationId || message.conversationId === conversationId)
        && (message.content.toLocaleLowerCase().includes(needle) || message.attachments.some((item) => item.filename.toLocaleLowerCase().includes(needle))))
      .filter(message=>beforeTime===null || +message.createdAt<Date.parse(beforeTime) || (+message.createdAt===Date.parse(beforeTime) && message.id>beforeId))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit).map(copy);
  }

  async listNotifications(identityId, { unreadOnly, limit, beforeTime = null, beforeId = null }) {
    return [...this.#notifications.values()].filter((value) => value.identityId === identityId && this.#visible(this.#messageIds.get(value.messageId), identityId) && (!unreadOnly || !value.readAt))
      .filter(value=>beforeTime===null || +value.createdAt<Date.parse(beforeTime) || (+value.createdAt===Date.parse(beforeTime) && value.id>beforeId))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)).slice(0, limit).map(copy);
  }

  async markNotificationRead(notificationId, identityId, now) {
    return this.#exclusive(async () => {
      const value = this.#notifications.get(notificationId);
      if (!value || value.identityId !== identityId) return null;
      value.readAt ??= now;
      return copy(value);
    });
  }

  async cleanup({ conversationId, identityId, action, throughSequence, messageId, now }) {
    return this.#exclusive(async () => {
      const conversation = this.#conversations.get(conversationId);
      const member = conversation?.participants.find(p => p.identityId === identityId && !p.leftAt);
      if (!member) return null;
      if (action === 'message') {
        const message = this.#messageIds.get(messageId);
        if (!message || message.conversationId !== conversationId) return null;
        this.#hiddenMessages.add(`${identityId}:${messageId}`);
      } else {
        if (throughSequence > conversation.lastMessageSequence) throw new PlatformError('messaging_cursor_invalid', 'Cleanup cursor is invalid', { status: 400 });
        member.clearedThroughSequence = Math.max(member.clearedThroughSequence ?? 0, throughSequence);
        member.lastReadSequence = Math.max(member.lastReadSequence, throughSequence);
        if (action === 'remove') member.removedThroughSequence = Math.max(member.removedThroughSequence ?? 0, throughSequence);
      }
      const event = this.#event({ type: 'conversation.cleaned', conversation, authorIdentityId: identityId,
        audienceIdentityIds: [identityId], data: { action, messageId, throughSequence }, now });
      return { event: copy(event) };
    });
  }

  async setPresence({ identityId, state, connectionId, ttlSeconds, now }) {
    return this.#exclusive(async () => {
      if (!this.#presenceConnections.has(identityId)) this.#presenceConnections.set(identityId, new Set());
      const connections = this.#presenceConnections.get(identityId);
      const current = this.#presence.get(identityId);
      if (state === "offline") connections.delete(connectionId); else connections.add(connectionId);
      const effectiveState = connections.size === 0 ? "offline" : state === "offline"
        ? (current?.state === "away" ? "away" : "online")
        : state;
      const value = {
        identityId, state: effectiveState, connectionCount: connections.size,
        lastSeenAt: now, expiresAt: connections.size ? new Date(now.getTime() + ttlSeconds * 1000) : null,
        revision: (current?.revision ?? 0) + 1,
      };
      this.#presence.set(identityId, value);
      return copy(value);
    });
  }

  async getPresence(requesterIdentityId, identityIds, now) {
    const shared = new Set();
    for (const conversation of this.#conversations.values()) {
      if (!conversation.participants.some((value) => value.identityId === requesterIdentityId && !value.leftAt)) continue;
      for (const participant of conversation.participants) if (!participant.leftAt) shared.add(participant.identityId);
    }
    return identityIds.filter((identityId) => shared.has(identityId) || identityId === requesterIdentityId).map((identityId) => {
      const current = this.#presence.get(identityId);
      if (!current || (current.expiresAt && current.expiresAt <= now)) return { identityId, state: "offline", connectionCount: 0, lastSeenAt: current?.lastSeenAt ?? now, expiresAt: null, revision: current?.revision ?? 0 };
      return copy(current);
    });
  }

  async listEvents(identityId, { after, limit }) {
    return this.#events.filter((value) => value.sequence > after && value.audienceIdentityIds.includes(identityId)).slice(0, limit).map(copy);
  }

  async findEvent(eventId) {
    return copy(this.#events.find((value) => value.id === eventId) ?? null);
  }
}
