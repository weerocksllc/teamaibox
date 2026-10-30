import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

export class MessagingRealtimeGateway {
  #service;
  #connections = new Map();
  #byIdentity = new Map();

  constructor({ service }) {
    if (!service?.replayEvents || !service?.setPresence || !service?.gatewayEvent || !service?.recordGatewayDelivery) {
      throw new TypeError("Messaging realtime gateway dependencies are incomplete");
    }
    this.#service = service;
  }

  async connect({ context, after = 0, send }) {
    if (typeof send !== "function") throw new TypeError("Messaging realtime send callback is required");
    const connectionId = randomUUID();
    const replay = await this.#service.replayEvents(context, { after, limit: 1000 });
    const identityId = context.actorIdentityId;
    const connection = { id: connectionId, identityId, context: structuredClone(context), send, closed: false, cursor: replay.cursor };
    this.#connections.set(connectionId, connection);
    if (!this.#byIdentity.has(identityId)) this.#byIdentity.set(identityId, new Set());
    this.#byIdentity.get(identityId).add(connectionId);
    try {
      for (const event of replay.events) await send(event);
      await this.#service.setPresence(context, { state: "online", connectionId, ttlSeconds: 60 });
    } catch (error) {
      this.#connections.delete(connectionId);
      this.#byIdentity.get(identityId)?.delete(connectionId);
      throw error;
    }
    return Object.freeze({
      connectionId,
      replayCursor: replay.cursor,
      heartbeat: async () => {
        if (connection.closed) throw new PlatformError("messaging_connection_closed", "Messaging connection is closed", { status: 409 });
        return this.#service.setPresence(context, { state: "online", connectionId, ttlSeconds: 60 });
      },
      close: async () => this.#close(connection),
    });
  }

  async publish(eventId, authority = "messaging-outbox.v1") {
    const event = await this.#service.gatewayEvent(authority, eventId);
    const delivered = new Set();
    let failedConnections = 0;
    for (const identityId of event.audienceIdentityIds) {
      for (const connectionId of this.#byIdentity.get(identityId) ?? []) {
        const connection = this.#connections.get(connectionId);
        if (!connection || connection.closed || event.public.sequence <= connection.cursor) continue;
        try {
          await connection.send(event.public);
          connection.cursor = event.public.sequence;
          delivered.add(identityId);
        } catch {
          failedConnections += 1;
          try { await this.#close(connection); } catch { /* durable replay cursor remains authoritative */ }
        }
      }
    }
    if (event.public.type === "message.created" && event.public.messageId) {
      for (const identityId of delivered) {
        if (identityId !== event.authorIdentityId) await this.#service.recordGatewayDelivery(authority, { messageId: event.public.messageId, identityId });
      }
    }
    return Object.freeze({ eventId, deliveredIdentities: delivered.size, failedConnections });
  }

  async #close(connection) {
    if (connection.closed) return false;
    connection.closed = true;
    this.#connections.delete(connection.id);
    const values = this.#byIdentity.get(connection.identityId);
    values?.delete(connection.id);
    if (!values?.size) this.#byIdentity.delete(connection.identityId);
    await this.#service.setPresence(connection.context, { state: "offline", connectionId: connection.id, ttlSeconds: 60 });
    return true;
  }
}
