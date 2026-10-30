import assert from "node:assert/strict";
import test from "node:test";

import { MemoryMessagingRepository } from "../src/memory-repository.mjs";
import { MessagingService } from "../src/messaging-service.mjs";
import { MessagingRealtimeGateway } from "../src/realtime-gateway.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199521";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199522";

function context(actorIdentityId) {
  return { actorIdentityId, actorKind: "local_user", permissions: ["message:read", "message:write", "message:manage"] };
}

test("realtime gateway replays durable events resumes cursors and advances delivery state", async () => {
  const sink = [];
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(),
    attachmentVerifier: { async resolveAttachment() { return null; }, async issueDownloadReference() { return null; } },
    eventSink: async (event) => sink.push(structuredClone(event)),
  });
  const conversation = await service.createConversation(context(OWNER), {
    kind: "direct",
    participantIdentityIds: [OWNER, MEMBER],
  });
  const gateway = new MessagingRealtimeGateway({ service });
  const ownerEvents = [];
  const memberEvents = [];
  const owner = await gateway.connect({ context: context(OWNER), after: 0, send: async (event) => ownerEvents.push(event) });
  const member = await gateway.connect({ context: context(MEMBER), after: 0, send: async (event) => memberEvents.push(event) });
  assert.equal(ownerEvents[0].type, "conversation.created");
  assert.equal(memberEvents[0].type, "conversation.created");

  const message = await service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "realtime-001",
    content: "实时消息",
  });
  const created = sink.at(-1);
  const published = await gateway.publish(created.eventId);
  assert.equal(published.deliveredIdentities, 2);
  assert.equal(published.failedConnections, 0);
  assert.equal(ownerEvents.at(-1).messageId, message.id);
  assert.equal(memberEvents.at(-1).messageId, message.id);
  const history = await service.history(context(MEMBER), conversation.id);
  assert.equal(history[0].delivery.find((value) => value.identityId === MEMBER).state, "delivered");

  const cursor = memberEvents.at(-1).sequence;
  assert.equal(await member.close(), true);
  const resumedEvents = [];
  const resumed = await gateway.connect({ context: context(MEMBER), after: cursor, send: async (event) => resumedEvents.push(event) });
  assert.ok(resumedEvents.every((event) => event.sequence > cursor));
  assert.equal(await owner.close(), true);
  assert.equal(await resumed.close(), true);
});

test("one broken realtime connection does not block authorized peers", async () => {
  const sink = [];
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(),
    attachmentVerifier: { async resolveAttachment() { return null; }, async issueDownloadReference() { return null; } },
    eventSink: async (event) => sink.push(structuredClone(event)),
  });
  const conversation = await service.createConversation(context(OWNER), { kind: "direct", participantIdentityIds: [OWNER, MEMBER] });
  const gateway = new MessagingRealtimeGateway({ service });
  await gateway.connect({ context: context(MEMBER), send: async (event) => { if (event.type === "message.created") throw new Error("socket closed"); } });
  const received = [];
  await gateway.connect({ context: context(OWNER), send: async (event) => received.push(event) });
  await service.sendMessage(context(OWNER), conversation.id, { idempotencyKey: "broken-peer-001", content: "still delivered" });
  const published = await gateway.publish(sink.at(-1).eventId);
  assert.equal(published.failedConnections, 1);
  assert.equal(published.deliveredIdentities, 1);
  assert.equal(received.at(-1).type, "message.created");
});

test("gateway authority and connection lifecycle fail closed", async () => {
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(),
    attachmentVerifier: { async resolveAttachment() { return null; }, async issueDownloadReference() { return null; } },
  });
  await service.createConversation(context(OWNER), { kind: "direct", participantIdentityIds: [OWNER, MEMBER] });
  const replay = await service.replayEvents(context(OWNER));
  await assert.rejects(service.gatewayEvent("browser", replay.events[0].id), { code: "messaging_gateway_denied" });
  const gateway = new MessagingRealtimeGateway({ service });
  const connection = await gateway.connect({ context: context(OWNER), send: async () => {} });
  assert.equal(await connection.close(), true);
  assert.equal(await connection.close(), false);
  await assert.rejects(connection.heartbeat(), { code: "messaging_connection_closed" });
});
