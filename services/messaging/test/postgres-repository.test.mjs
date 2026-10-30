import assert from "node:assert/strict";
import test from "node:test";

import { PostgresMessagingRepository } from "../src/postgres-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c0174199531";
const MEMBER = "018f6f18-24d7-7c21-9b62-8c0174199532";
const CONVERSATION = "018f6f18-24d7-7c21-9b62-8c0174199533";
const MESSAGE = "018f6f18-24d7-7c21-9b62-8c0174199534";
const EVENT = "018f6f18-24d7-7c21-9b62-8c0174199535";
const NOW = new Date("2026-08-11T06:00:00.000Z");
const DIGEST_BYTES = Buffer.from("ab".repeat(32), "hex");

test('search and notifications bind keyset cursors without losing ownership filters',async()=>{
 const calls=[];const database={async query(sql,values){calls.push({sql,values});return {rows:[]}},async transaction(fn){return fn(this)}};
 const repo=new PostgresMessagingRepository({database});const beforeTime=NOW.toISOString();
 await repo.searchMessages(OWNER,{query:'test',conversationId:null,limit:50,beforeTime,beforeId:MESSAGE});
 await repo.listNotifications(OWNER,{unreadOnly:true,limit:100,beforeTime,beforeId:MESSAGE});
 assert.deepEqual(calls[0].values,[OWNER,null,'test',50,beforeTime,MESSAGE]);
 assert.match(calls[0].sql,/participant.identity_id=\$1/);assert.match(calls[0].sql,/message.id>\$6::uuid/);
 assert.deepEqual(calls[1].values,[OWNER,true,100,beforeTime,MESSAGE]);assert.match(calls[1].sql,/identity_id=\$1/);assert.match(calls[1].sql,/id>\$5::uuid/);
});

test("history SQL selects newest pages with a parameterized backward cursor", async () => {
  const calls=[];
  const database={async query(sql,values){calls.push({sql,values});return {rows:[]}},async transaction(operation){return operation(this)}};
  const repository=new PostgresMessagingRepository({database});
  await repository.listMessages(CONVERSATION,{after:0,before:9000,limit:100});
  assert.match(calls[0].sql,/message_sequence < \$2/);
  assert.match(calls[0].sql,/message_sequence DESC LIMIT \$3/);
  assert.deepEqual(calls[0].values,[CONVERSATION,9000,100]);
});

function conversationRow(overrides = {}) {
  return {
    id: CONVERSATION,
    conversation_kind: "direct",
    title: null,
    team_key: null,
    direct_key: DIGEST_BYTES,
    created_by_identity_id: OWNER,
    last_message_sequence: 0,
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function participantRows() {
  return [
    { conversation_id: CONVERSATION, identity_id: OWNER, participant_role: "owner", joined_at: NOW, left_at: null, last_read_sequence: 0 },
    { conversation_id: CONVERSATION, identity_id: MEMBER, participant_role: "member", joined_at: NOW, left_at: null, last_read_sequence: 0 },
  ];
}

function messageRow() {
  return {
    id: MESSAGE,
    conversation_id: CONVERSATION,
    message_sequence: 1,
    author_identity_id: OWNER,
    author_kind: "user",
    application_key: null,
    idempotency_key: "postgres-message-1",
    request_digest: DIGEST_BYTES,
    content: "private body",
    reply_to_message_id: null,
    created_at: NOW,
    edited_at: null,
    deleted_at: null,
  };
}

function eventRow(type = "message.created") {
  return {
    sequence_id: 8,
    event_id: EVENT,
    conversation_id: CONVERSATION,
    message_id: type === "message.created" ? MESSAGE : null,
    event_type: type,
    audience_identity_ids: [OWNER, MEMBER],
    author_identity_id: OWNER,
    event_data: { sequence: 1, authorIdentityId: OWNER },
    created_at: NOW,
  };
}

test("PostgreSQL conversation creation persists participants event and outbox in one transaction", async () => {
  const calls = [];
  const transaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("WHERE direct_key=$1")) return { rows: [] };
      if (sql.includes("INSERT INTO platform.messaging_conversations")) return { rows: [{ id: CONVERSATION }] };
      if (sql.includes("SELECT c.*")) return { rows: [conversationRow()] };
      if (sql.includes("SELECT * FROM platform.messaging_participants")) return { rows: participantRows() };
      if (sql.includes("INSERT INTO platform.messaging_events")) return { rows: [eventRow("conversation.created")] };
      return { rows: [] };
    },
  };
  const database = {
    query: transaction.query,
    async transaction(operation) { return operation(transaction); },
  };
  const repository = new PostgresMessagingRepository({ database });
  const result = await repository.createConversation({
    id: CONVERSATION,
    kind: "direct",
    title: null,
    teamKey: null,
    directKey: `sha256:${"ab".repeat(32)}`,
    createdByIdentityId: OWNER,
    participants: participantRows().map((row) => ({
      identityId: row.identity_id, role: row.participant_role, joinedAt: NOW, leftAt: null, lastReadSequence: 0,
    })),
    lastMessageSequence: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(result.inserted, true);
  assert.deepEqual(result.conversation.participants.map((value) => value.identityId), [OWNER, MEMBER]);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO platform.messaging_participants")).length, 2);
  const outbox = calls.find((call) => call.sql.includes("platform.enqueue_outbox"));
  assert.ok(outbox);
  assert.equal(outbox.values[0], "teamaibox.events.v1.messaging");
  assert.ok(!JSON.stringify(outbox.values).includes("private"));
});

test("PostgreSQL message transaction persists history receipts notification event and redacted outbox", async () => {
  const calls = [];
  const transaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("SELECT c.*")) return { rows: [conversationRow()] };
      if (sql.includes("SELECT * FROM platform.messaging_participants")) return { rows: participantRows() };
      if (sql.includes("idempotency_key=$3 FOR UPDATE")) return { rows: [] };
      if (sql.includes("RETURNING last_message_sequence")) return { rows: [{ last_message_sequence: 1 }] };
      if (sql.includes("SELECT * FROM platform.messaging_messages WHERE id=$1")) return { rows: [messageRow()] };
      if (sql.includes("SELECT * FROM platform.messaging_attachments")) return { rows: [] };
      if (sql.includes("SELECT * FROM platform.messaging_delivery_receipts")) return { rows: [
        { identity_id: OWNER, delivery_state: "read", delivered_at: NOW, read_at: NOW },
        { identity_id: MEMBER, delivery_state: "queued", delivered_at: null, read_at: null },
      ] };
      if (sql.includes("INSERT INTO platform.messaging_events")) return { rows: [eventRow()] };
      return { rows: [] };
    },
  };
  const database = { query: transaction.query, async transaction(operation) { return operation(transaction); } };
  const repository = new PostgresMessagingRepository({ database });
  const result = await repository.insertMessage({
    id: MESSAGE,
    conversationId: CONVERSATION,
    authorIdentityId: OWNER,
    authorKind: "user",
    applicationKey: null,
    idempotencyKey: "postgres-message-1",
    requestDigest: `sha256:${"ab".repeat(32)}`,
    content: "private body",
    attachments: [],
    replyToMessageId: null,
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
  });
  assert.equal(result.inserted, true);
  assert.equal(result.message.delivery.length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO platform.messaging_delivery_receipts")).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO platform.messaging_notifications")).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO platform.messaging_events")).length, 1);
  const outbox = calls.find((call) => call.sql.includes("platform.enqueue_outbox"));
  assert.ok(outbox);
  assert.ok(!JSON.stringify(outbox.values).includes("private body"));
});

test("PostgreSQL search always joins active membership before matching content", async () => {
  const calls = [];
  const database = {
    async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; },
    async transaction() { throw new Error("not used"); },
  };
  const repository = new PostgresMessagingRepository({ database });
  assert.deepEqual(await repository.searchMessages(MEMBER, { query: "secret", conversationId: null, limit: 10 }), []);
  assert.match(calls[0].sql, /JOIN platform\.messaging_participants/);
  assert.match(calls[0].sql, /participant\.identity_id=\$1 AND participant\.left_at IS NULL/);
  assert.deepEqual(calls[0].values, [MEMBER, null, "secret", 10, null, null]);
});

test("PostgreSQL attachment lookup hides missing or non-member rows", async () => {
  const calls = [];
  const database = {
    async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; },
    async transaction() { throw new Error("not used"); },
  };
  const repository = new PostgresMessagingRepository({ database });
  assert.equal(await repository.findAttachmentForMember(MESSAGE, MEMBER, 1), null);
  assert.match(calls[0].sql, /JOIN platform\.messaging_participants/);
  assert.match(calls[0].sql, /participant\.identity_id=\$2 AND participant\.left_at IS NULL/);
  assert.deepEqual(calls[0].values, [MESSAGE, MEMBER, 1]);
});

test("PostgreSQL messaging repository refuses non-transactional storage", () => {
  assert.throws(() => new PostgresMessagingRepository({ database: { query: async () => ({ rows: [] }) } }), /requires transactions/);
});

test('already-read own receipt still advances a member cursor and clears only its conversation notifications',async()=>{
 const calls=[];let advanced=false;
 const database={async transaction(fn){return fn(this)},async query(sql,values){
  calls.push({sql,values});
  if(sql.includes('SELECT receipt.*'))return {rows:[{delivery_state:'read',conversation_id:CONVERSATION,message_sequence:1}]};
  if(sql.includes('RETURNING identity_id')){const rows=advanced?[]:[{identity_id:OWNER}];advanced=true;return {rows};}
  if(sql.includes('SELECT * FROM platform.messaging_messages'))return {rows:[messageRow()]};
  if(sql.includes('INSERT INTO platform.messaging_events'))return {rows:[eventRow('message.read')]};
  return {rows:[]};
 }};
 const repository=new PostgresMessagingRepository({database});
 const input={messageId:MESSAGE,identityId:OWNER,state:'read',now:NOW};
 assert.equal((await repository.markDelivery(input)).event.type,'message.read');
 assert.equal((await repository.markDelivery(input)).event,null);
 assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO platform.messaging_events')).length,1);
 assert.match(calls.find(c=>c.sql.includes('SELECT receipt.*')).sql,/participant.left_at IS NULL/);
 const cursor=calls.find(c=>c.sql.includes('RETURNING identity_id'));assert.deepEqual(cursor.values,[CONVERSATION,OWNER,1]);assert.match(cursor.sql,/last_read_sequence<\$3/);
 const notification=calls.find(c=>c.sql.includes('UPDATE platform.messaging_notifications'));assert.deepEqual(notification.values,[CONVERSATION,OWNER,1,NOW]);assert.match(notification.sql,/notification.identity_id=\$2/);
});
