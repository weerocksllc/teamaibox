import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MessagingHttpApi, matchesMessagingHttpRoute } from "../src/messaging/messaging-http-api.mjs";
import { MemoryMessagingRepository } from "../../../services/messaging/src/memory-repository.mjs";
import { MessagingService } from "../../../services/messaging/src/messaging-service.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199502";

test("long messages, more than sixteen attachments and large groups work without losing member checks", async () => {
  const { api, service } = fixture();
  const ids = [OWNER, MEMBER, ...Array.from({length: 509}, () => randomUUID())];
  const created = await api.handle({method:"POST", pathname:"/api/v1/messaging/conversations", context:context(),
    body:{kind:"group",title:"群".repeat(200),participant_identity_ids:ids}});
  assert.equal(created.body.participants.length, 511);
  const actor = {actorIdentityId:OWNER,actorKind:"local_user",permissions:["message:read","message:manage","message:write"]};
  const updated = await service.addParticipant(actor, created.body.id, {identityId:randomUUID()});
  assert.equal(updated.participants.length, 512);
  const sent = await api.handle({method:"POST", pathname:`/api/v1/messaging/conversations/${created.body.id}/messages`,
    context:context(),headers:{"idempotency-key":"resource-message"},
    body:{content:"长消息".repeat(22000),attachment_reference_ids:Array.from({length:40}, () => randomUUID())}});
  assert.equal(sent.body.content.length, 66000);
  assert.equal(sent.body.attachments.length, 40);
  assert.equal(sent.body.delivery.length, 512);
  const downloaded = await api.handle({method:"POST",pathname:`/api/v1/messaging/messages/${sent.body.id}/attachments/40/download`,context:context(MEMBER),body:{}});
  assert.equal(downloaded.status,201);
  await assert.rejects(api.handle({method:"POST",pathname:`/api/v1/messaging/messages/${sent.body.id}/attachments/40/download`,context:context(randomUUID()),body:{}}),{code:"messaging_attachment_not_found"});
  const presence = await service.presence(actor, ids);
  assert.ok(Array.isArray(presence));
  const searched = await service.search(actor,{query:"长",conversationId:created.body.id});
  assert.equal(searched[0].id,sent.body.id);
});

test("history supports newest-first page selection and all older pages beyond five hundred", async () => {
  const { api } = fixture();
  const created = await api.handle({method:"POST",pathname:"/api/v1/messaging/conversations",context:context(),body:{kind:"direct",participant_identity_ids:[OWNER,MEMBER]}});
  const pathname=`/api/v1/messaging/conversations/${created.body.id}/messages`;
  for(let i=1;i<=507;i++)await api.handle({method:"POST",pathname,context:context(),headers:{"idempotency-key":`history-${i}`},body:{content:`m${i}`}});
  let before=Number.MAX_SAFE_INTEGER;const sequences=[];
  for(;;){const result=await api.handle({method:"GET",pathname,context:context(MEMBER),query:new URLSearchParams(`before=${before}&limit=100`)});
    const page=result.body.data;if(!page.length)break;
    if(before===Number.MAX_SAFE_INTEGER)assert.equal(page.at(-1).sequence,507);
    sequences.unshift(...page.map(item=>item.sequence));before=page[0].sequence;
  }
  assert.deepEqual(sequences,Array.from({length:507},(_,i)=>i+1));
  await assert.rejects(api.handle({method:"GET",pathname,context:context(),query:new URLSearchParams('after=2&before=10')}),{code:"messaging_cursor_invalid"});
});

function context(identityId = OWNER) {
  return { identityId, permissions: ["message:read", "message:write", "message:manage"] };
}

function fixture() {
  const downloadRequests = [];
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(),
    attachmentVerifier: {
      async resolveAttachment() {
        return { objectId: "018f6f18-24d7-7c21-9b62-8c0174199511", objectVersion: 1, filename: "brief.txt", mediaType: "text/plain", byteSize: 5, sha256: `sha256:${"a".repeat(64)}` };
      },
      async issueDownloadReference(input) {
        downloadRequests.push(structuredClone(input));
        return { referenceId: "018f6f18-24d7-7c21-9b62-8c0174199512", expiresAt: "2026-08-11T05:05:00.000Z" };
      },
    },
  });
  return { api: new MessagingHttpApi({ service }), service, downloadRequests };
}

test("messaging HTTP routes expose durable conversation, message, and replay contracts", async () => {
  const { api } = fixture();
  const created = await api.handle({
    method: "POST", pathname: "/api/v1/messaging/conversations", context: context(),
    body: { kind: "direct", participant_identity_ids: [OWNER, MEMBER] },
  });
  assert.equal(created.status, 201);
  const sent = await api.handle({
    method: "POST", pathname: `/api/v1/messaging/conversations/${created.body.id}/messages`, context: context(),
    headers: { "idempotency-key": "message-http-001" }, body: { content: "hello" },
  });
  assert.equal(sent.status, 201);
  const history = await api.handle({
    method: "GET", pathname: `/api/v1/messaging/conversations/${created.body.id}/messages`, context: context(MEMBER),
    query: new URLSearchParams("after=0&limit=10"),
  });
  assert.equal(history.body.data[0].id, sent.body.id);
  const events = await api.handle({
    method: "GET", pathname: "/api/v1/messaging/events", context: context(MEMBER),
    query: new URLSearchParams("after=0&once=1"), signal: new AbortController().signal,
  });
  const replay = [];
  for await (const event of events.events) replay.push(event);
  assert.ok(replay.some((event) => event.data.type === "message.created"));
});

test("messaging HTTP routes reject missing idempotency and invalid cursor input", async () => {
  const { api } = fixture();
  const created = await api.handle({
    method: "POST", pathname: "/api/v1/messaging/conversations", context: context(),
    body: { kind: "direct", participantIdentityIds: [OWNER, MEMBER] },
  });
  await assert.rejects(api.handle({
    method: "POST", pathname: `/api/v1/messaging/conversations/${created.body.id}/messages`, context: context(), body: { content: "hello" },
  }), { code: "messaging_idempotency_required" });
  await assert.rejects(api.handle({
    method: "GET", pathname: "/api/v1/messaging/conversations", context: context(), query: new URLSearchParams("limit=201"),
  }), { code: "messaging_cursor_invalid" });
  assert.equal(matchesMessagingHttpRoute("GET", "/api/v1/messaging/events"), true);
  assert.equal(matchesMessagingHttpRoute("DELETE", "/api/v1/messaging/events"), false);
});

test("messaging HTTP presence and attachment download are member scoped mutations", async () => {
  const { api, downloadRequests } = fixture();
  const created = await api.handle({
    method: "POST", pathname: "/api/v1/messaging/conversations", context: context(),
    body: { kind: "direct", participant_identity_ids: [OWNER, MEMBER] },
  });
  const sent = await api.handle({
    method: "POST", pathname: `/api/v1/messaging/conversations/${created.body.id}/messages`, context: context(),
    headers: { "idempotency-key": "attachment-http-001" },
    body: { content: "attached", attachment_reference_ids: ["018f6f18-24d7-7c21-9b62-8c0174199513"] },
  });
  const presence = await api.handle({
    method: "POST", pathname: "/api/v1/messaging/presence", context: context(MEMBER),
    body: { state: "online", connection_id: "018f6f18-24d7-7c21-9b62-8c0174199514", ttl_seconds: 60 },
  });
  assert.equal(presence.body.state, "online");
  const download = await api.handle({
    method: "POST", pathname: `/api/v1/messaging/messages/${sent.body.id}/attachments/1/download`, context: context(MEMBER), body: {},
  });
  assert.equal(download.status, 201);
  assert.equal(download.body.filename, "brief.txt");
  assert.equal(downloadRequests[0].actorIdentityId, MEMBER);
  assert.equal(matchesMessagingHttpRoute("POST", `/api/v1/messaging/messages/${sent.body.id}/attachments/1/download`), true);
});
