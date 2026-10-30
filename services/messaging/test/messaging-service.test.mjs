import assert from "node:assert/strict";
import test from "node:test";

import { MemoryMessagingRepository } from "../src/memory-repository.mjs";
import { MessagingService } from "../src/messaging-service.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199502";
const OTHER = "018f6f18-24d7-7c21-9b62-8c0174199503";
const BOT = "018f6f18-24d7-7c21-9b62-8c0174199504";
const REFERENCE = "018f6f18-24d7-7c21-9b62-8c0174199505";
const OBJECT = "018f6f18-24d7-7c21-9b62-8c0174199506";

function context(actorIdentityId, permissions = ["message:read", "message:write", "message:manage"], actorKind = "local_user") {
  return { actorIdentityId, actorKind, permissions, ...(actorKind === "service_account" ? { applicationKey: "bot.release-notes" } : {}) };
}

function fixture() {
  const audits = [];
  const events = [];
  const attachmentRequests = [];
  const attachmentDownloads = [];
  let tick = 0;
  const repository = new MemoryMessagingRepository();
  const service = new MessagingService({
    repository,
    clock: () => new Date(Date.UTC(2026, 7, 11, 5, 0, tick++)),
    attachmentVerifier: {
      async resolveAttachment(input) {
        attachmentRequests.push(structuredClone(input));
        if (input.referenceId !== REFERENCE || input.actorIdentityId !== OWNER) return null;
        return {
          objectId: OBJECT,
          objectVersion: 3,
          filename: "design.png",
          mediaType: "image/png",
          byteSize: 4096,
          sha256: `sha256:${"a".repeat(64)}`,
        };
      },
      async issueDownloadReference(input) {
        attachmentDownloads.push(structuredClone(input));
        return { referenceId: REFERENCE, expiresAt: "2026-08-11T05:05:00.000Z" };
      },
    },
    audit: async (event) => audits.push(structuredClone(event)),
    eventSink: async (event) => events.push(structuredClone(event)),
  });
  return { service, repository, audits, events, attachmentRequests, attachmentDownloads };
}

async function direct(service) {
  return service.createConversation(context(OWNER), {
    kind: "direct",
    participantIdentityIds: [MEMBER, OWNER],
  });
}

test('personal cleanup persists across service recreation, isolates members and keeps newer messages', async()=>{
 const f=fixture(), {service,repository}=f, c=await direct(service);
 const first=await service.sendMessage(context(OWNER),c.id,{content:'cleanup first',idempotencyKey:'cleanup-first',attachmentReferenceIds:[REFERENCE]});
 const second=await service.sendMessage(context(OWNER),c.id,{content:'cleanup second',idempotencyKey:'cleanup-second'});
 await assert.rejects(service.cleanup(context(MEMBER),c.id,{action:'clear',throughSequence:2}),{code:'messaging_cleanup_invalid'});
 await assert.rejects(service.cleanup(context(OTHER),c.id,{action:'clear',throughSequence:2,confirm:true}),{code:'messaging_conversation_not_found'});
 await service.cleanup(context(MEMBER),c.id,{action:'message',messageId:first.id,confirm:true});
 assert.deepEqual((await service.history(context(MEMBER),c.id)).map(x=>x.id),[second.id]);
 assert.equal((await service.history(context(OWNER),c.id)).length,2);
 assert.equal((await service.search(context(MEMBER),{query:'cleanup'})).length,1);
 assert.equal((await service.notifications(context(MEMBER),{unreadOnly:true})).length,1);
 assert.equal((await service.listConversations(context(MEMBER)))[0].unreadCount,1);
 await assert.rejects(service.attachmentDownload(context(MEMBER),first.id,1),{code:'messaging_attachment_not_found'});
 assert.equal((await service.attachmentDownload(context(OWNER),first.id,1)).filename,'design.png');
 await service.cleanup(context(MEMBER),c.id,{action:'remove',throughSequence:2,confirm:true});
 assert.equal((await service.listConversations(context(MEMBER))).length,0);
 assert.equal((await service.history(context(MEMBER),c.id)).length,0);
 assert.equal((await service.notifications(context(MEMBER),{unreadOnly:true})).length,0);
 assert.equal((await service.listConversations(context(OWNER))).length,1);
 const fresh=new MessagingService({repository,attachmentVerifier:{resolveAttachment(){},issueDownloadReference(){}}});
 assert.equal((await fresh.listConversations(context(MEMBER))).length,0);
 const third=await fresh.sendMessage(context(OWNER),c.id,{content:'new message',idempotencyKey:'cleanup-newer'});
 await fresh.cleanup(context(MEMBER),c.id,{action:'remove',throughSequence:2,confirm:true});
 assert.deepEqual((await fresh.history(context(MEMBER),c.id)).map(x=>x.id),[third.id]);
 assert.equal((await fresh.listConversations(context(MEMBER))).length,1);
 await fresh.cleanup(context(MEMBER),c.id,{action:'remove',throughSequence:3,confirm:true});
 const reopened=await fresh.createConversation(context(MEMBER),{kind:'direct',participantIdentityIds:[OWNER,MEMBER]});
 assert.equal(reopened.id,c.id);assert.equal((await fresh.history(context(MEMBER),c.id)).length,0);
 assert.equal((await fresh.listConversations(context(MEMBER))).length,1);
 assert.equal((await repository.listEvents(OWNER,{after:0,limit:100})).filter(e=>e.type==='conversation.cleaned').length,0);
});

test('search and unread notifications paginate beyond their original first page',async()=>{
 const {service}=fixture();const conversation=await direct(service);
 for(let i=0;i<137;i++)await service.sendMessage(context(OWNER),conversation.id,{content:`分页 ${i}`,idempotencyKey:`page-test-${i}`});
 for(const kind of ['search','notifications']){
  const found=[];let beforeTime=null,beforeId=null;
  for(;;){
   const page=kind==='search'?await service.search(context(MEMBER),{query:'分页',limit:50,beforeTime,beforeId})
    :await service.notifications(context(MEMBER),{unreadOnly:true,limit:100,beforeTime,beforeId});
   found.push(...page);if(!page.length)break;
   const last=page.at(-1);beforeTime=last.createdAt;beforeId=last.id;
   if(kind==='notifications')await service.markNotificationRead(context(MEMBER),page[0].id);
  }
  assert.equal(found.length,137);assert.equal(new Set(found.map(v=>v.id)).size,137);
 }
 assert.deepEqual(await service.search(context(OTHER),{query:'分页'}),[]);
 await assert.rejects(service.search(context(MEMBER),{query:'分页',beforeTime:'invalid',beforeId:OWNER}),{code:'messaging_cursor_invalid'});
});

test("direct conversations are canonical unique and group membership is permission managed", async () => {
  const { service } = fixture();
  const first = await direct(service);
  const repeated = await service.createConversation(context(MEMBER), {
    kind: "direct",
    participantIdentityIds: [OWNER, MEMBER],
  });
  assert.equal(repeated.id, first.id);
  assert.equal(first.kind, "direct");
  assert.deepEqual(first.participants.map((value) => value.identityId).sort(), [OWNER, MEMBER].sort());

  const group = await service.createConversation(context(OWNER), {
    kind: "group",
    title: "产品发布",
    teamKey: "team.product",
    participantIdentityIds: [OWNER, MEMBER],
  });
  const updated = await service.addParticipant(context(OWNER), group.id, { identityId: BOT, role: "member" });
  assert.equal(updated.participants.length, 3);
  await assert.rejects(
    service.addParticipant(context(MEMBER, ["message:read", "message:write", "message:manage"]), group.id, { identityId: OTHER }),
    { code: "messaging_manage_denied" },
  );
});

test("messages persist immutable attachment facts without reusable object references or audited content", async () => {
  const { service, audits, attachmentRequests, attachmentDownloads } = fixture();
  const conversation = await direct(service);
  const message = await service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "message-001",
    content: "confidential launch details",
    attachmentReferenceIds: [REFERENCE],
  });
  assert.equal(message.sequence, 1);
  assert.equal(message.attachments[0].objectId, OBJECT);
  assert.equal(message.attachments[0].objectVersion, 3);
  assert.ok(!JSON.stringify(message.attachments).includes(REFERENCE));
  assert.deepEqual(attachmentRequests[0], {
    actorIdentityId: OWNER,
    referenceId: REFERENCE,
    audience: "messaging.attachment",
    requiredOperation: "read",
  });
  assert.ok(!JSON.stringify(audits).includes("confidential launch details"));
  assert.ok(!JSON.stringify(audits).includes(REFERENCE));

  const download = await service.attachmentDownload(context(MEMBER, ["message:read"]), message.id, 1);
  assert.equal(download.referenceId, REFERENCE);
  assert.equal(download.filename, "design.png");
  assert.deepEqual(attachmentDownloads[0], {
    actorIdentityId: MEMBER, objectId: OBJECT, objectVersion: 3, expiresInSeconds: 300,
  });
  await assert.rejects(service.attachmentDownload(context(OTHER, ["message:read"]), message.id, 1), {
    code: "messaging_attachment_not_found",
  });

  const replay = await service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "message-001",
    content: "confidential launch details",
    attachmentReferenceIds: [REFERENCE],
  });
  assert.equal(replay.id, message.id);
  await assert.rejects(service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "message-001",
    content: "different",
  }), { code: "messaging_idempotency_conflict" });
});

test("history search notifications and delivery receipts are membership scoped", async () => {
  const { service } = fixture();
  const conversation = await direct(service);
  const message = await service.sendMessage(context(OWNER), conversation.id, {
    idempotencyKey: "message-search-001",
    content: "发布窗口是周五晚上",
  });
  assert.equal((await service.history(context(MEMBER, ["message:read"]), conversation.id))[0].id, message.id);
  assert.equal((await service.search(context(MEMBER, ["message:read"]), { query: "周五" }))[0].id, message.id);
  assert.equal((await service.notifications(context(MEMBER, ["message:read"]), { unreadOnly: true })).length, 1);
  const read = await service.markRead(context(MEMBER, ["message:read"]), message.id);
  assert.equal(read.delivery.find((value) => value.identityId === MEMBER).state, "read");
  await assert.rejects(service.history(context(OTHER, ["message:read"]), conversation.id), { code: "messaging_conversation_not_found" });
  assert.deepEqual(await service.search(context(OTHER, ["message:read"]), { query: "周五" }), []);
});

test("replies cannot point across conversation boundaries", async () => {
  const { service } = fixture();
  const first = await direct(service);
  const second = await service.createConversation(context(OWNER), {
    kind: "group",
    title: "另一个会话",
    participantIdentityIds: [OWNER, OTHER],
  });
  const source = await service.sendMessage(context(OWNER), first.id, { idempotencyKey: "reply-source", content: "source" });
  await assert.rejects(service.sendMessage(context(OWNER), second.id, {
    idempotencyKey: "cross-conversation-reply",
    content: "invalid reply",
    replyToMessageId: source.id,
  }), { code: "messaging_reply_invalid" });
});

test('opening history ending in an own message advances read cursor once and clears earlier notifications',async()=>{
  const {service,events}=fixture();const conversation=await direct(service);
  const incoming=await service.sendMessage(context(OWNER),conversation.id,{idempotencyKey:'cursor-incoming',content:'hello'});
  const own=await service.sendMessage(context(MEMBER),conversation.id,{idempotencyKey:'cursor-own',content:'reply'});
  assert.equal(own.delivery.find(value=>value.identityId===MEMBER).state,'read');
  const before=events.length;await service.markRead(context(MEMBER),own.id);
  const current=(await service.listConversations(context(MEMBER))).find(value=>value.id===conversation.id);
  assert.equal(current.participants.find(value=>value.identityId===MEMBER).lastReadSequence,2);
  assert.deepEqual(await service.notifications(context(MEMBER),{unreadOnly:true}),[]);
  assert.equal(events.length,before+1);
  await service.markRead(context(MEMBER),own.id);assert.equal(events.length,before+1);
  await service.markRead(context(MEMBER),incoming.id);
  const after=(await service.listConversations(context(MEMBER))).find(value=>value.id===conversation.id);
  assert.equal(after.participants.find(value=>value.identityId===MEMBER).lastReadSequence,2);
  await assert.rejects(service.markRead(context(OTHER),own.id),{code:'messaging_message_not_found'});
});

test("authorized service accounts use the same participant and permission boundary as users", async () => {
  const { service } = fixture();
  const conversation = await service.createConversation(context(OWNER), {
    kind: "group",
    title: "自动化通知",
    participantIdentityIds: [OWNER, BOT],
  });
  const message = await service.sendMessage(context(BOT, ["message:read", "message:write"], "service_account"), conversation.id, {
    idempotencyKey: "bot-release-001",
    content: "构建已完成",
  });
  assert.equal(message.authorKind, "application");
  assert.equal(message.applicationKey, "bot.release-notes");
  await assert.rejects(service.sendMessage(context(OTHER, ["message:read", "message:write"], "service_account"), conversation.id, {
    idempotencyKey: "bot-outside-001",
    content: "should fail",
  }), { code: "messaging_conversation_not_found" });
});

test("presence is disclosed only to identities sharing a conversation and expires fail-closed", async () => {
  const { service } = fixture();
  await direct(service);
  const connectionId = "018f6f18-24d7-7c21-9b62-8c0174199510";
  assert.equal((await service.setPresence(context(OWNER, ["message:read"]), { state: "online", connectionId, ttlSeconds: 60 })).state, "online");
  const shared = await service.presence(context(MEMBER, ["message:read"]), [OWNER, OTHER]);
  assert.deepEqual(shared.map((value) => value.identityId), [OWNER]);
  assert.equal(shared[0].state, "online");
  assert.equal((await service.setPresence(context(OWNER, ["message:read"]), { state: "offline", connectionId, ttlSeconds: 60 })).state, "offline");
});
