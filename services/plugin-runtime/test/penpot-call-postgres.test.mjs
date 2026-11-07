import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PostgresPenpotCallRepository, PostgresPenpotEditorRepository } from "../src/postgres-penpot-call-repository.mjs";

const connectionString = process.env.TEAMAIBOX_PENPOT_TEST_DATABASE_URL;
test("native design context uses atomic PostgreSQL consumption without raw credentials or code", {
  skip: !connectionString && "Requires an explicitly supplied empty, disposable PostgreSQL database",
}, async () => {
  const { default: pg } = await import("../../../packages/persistence/node_modules/pg/lib/index.js");
  const database = new pg.Pool({ connectionString, max: 12 });
  try {
    const tables = await database.query(`SELECT count(*)::integer AS count FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema')`);
    assert.equal(tables.rows[0].count, 0, "Use a new empty database; existing tables will not be changed");
    await database.query("CREATE SCHEMA design");
    await database.query("CREATE SCHEMA iam; CREATE TABLE iam.identities(id uuid PRIMARY KEY)");
    for(const name of ['000120_penpot_call_boundary.up.sql','000125_penpot_write_review.up.sql']){
      await database.query(await readFile(new URL('../../../packages/persistence/migrations/'+name,import.meta.url),'utf8'));
    }
    const proofs = new PostgresPenpotCallRepository({ database });
    const deliveries = new PostgresPenpotEditorRepository({ database });
    const digest = () => randomBytes(32).toString("hex"), now = Date.now();
    const binding = { identityId: randomUUID(), platformSessionId: "synthetic-platform-session",
      runtimeId: "synthetic-runtime", profileId: "synthetic-profile", connectionId: "synthetic-connection",
      generation: 1, sessionID: "synthetic-agent-session", fileId: "synthetic-file", pageId: "synthetic-page" };
    const call = { sessionID: binding.sessionID, messageID: "synthetic-message", callID: "synthetic-call",
      server: "teamaibox-penpot", tool: "execute_code" };
    const proof = { proofHash: digest(), call, binding, issuedAt: now, expiresAt: now + 15000 };
    await proofs.insert(proof);
    assert.equal(await proofs.consume({ ...proof, ...binding, identityId: "other-user", now }), null);
    assert.equal(await proofs.consume({ ...proof, ...binding, runtimeId: "other-runtime", now }), null);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => proofs.consume({ ...proof, ...binding, now })));
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.deepEqual(outcomes.find(Boolean), { call, binding, issuedAt: now, expiresAt: now + 15000 });
    assert.equal(await proofs.consume({ ...proof, ...binding, now }), null);

    const delivery = { ticketHash: digest(), requestHash: digest(), binding, issuedAt: now, expiresAt: now + 10000 };
    await database.query('INSERT INTO iam.identities(id) VALUES($1)',[binding.identityId]);
    await database.query('INSERT INTO design.editor_connections(identity_id,generation,binding,heartbeat_at) VALUES($1,1,$2,$3)',
      [binding.identityId,binding,new Date(now)]);
    const reviewId=randomUUID(), workspace={projectId:randomUUID()};
    const claim={...delivery,...binding,now,reviewId,workspace};
    await deliveries.insert(delivery);
    for (const changed of [{ identityId: "other-user" }, { platformSessionId: "other-session" },
      { profileId: "other-profile" }, { requestHash: digest() }]) {
      assert.equal(await deliveries.consume({ ...claim, ...changed }), null);
    }
    const winners = await Promise.all(Array.from({ length: 8 }, () => deliveries.consume(claim)));
    assert.equal(winners.filter(Boolean).length, 1);
    assert.deepEqual(winners.find(Boolean), { binding, expiresAt: now + 10000 });
    assert.equal(await deliveries.consume(claim), null);
    assert.deepEqual(await deliveries.pending(binding.identityId,now),{reviewId,binding,workspace,uncertain:false});
    assert.equal(await deliveries.reviewed({...claim}),false,'a live operation cannot be acknowledged as missing');
    const competing={...delivery,ticketHash:digest()};
    await deliveries.insert(competing);
    await assert.rejects(deliveries.consume({...claim,ticketHash:competing.ticketHash,reviewId:randomUUID()}),{code:'23505'});
    assert.equal(await deliveries.settle(delivery.ticketHash,true,now+5),true);
    assert.equal(await deliveries.settle(delivery.ticketHash,false,now+6),false,'a late reply cannot clear the review');
    assert.equal(await deliveries.discardExpired(now+16000),1,'discard only the never-claimed competing ticket');
    assert.equal((await deliveries.pending(binding.identityId,now+16000)).uncertain,true);
    assert.equal(await deliveries.pending(randomUUID(),now+16000),null);
    assert.equal(await deliveries.reviewed({...claim,reviewId:randomUUID(),now:now+16000}),false);
    assert.equal(await deliveries.reviewed({...claim,now:now+16000}),true);
    assert.equal(await deliveries.pending(binding.identityId,now+16000),null);

    const expiredProof = { ...proof, proofHash: digest() };
    const expiredDelivery = { ...delivery, ticketHash: digest() };
    await proofs.insert(expiredProof); await deliveries.insert(expiredDelivery);
    assert.equal(await proofs.consume({ ...expiredProof, ...binding, now: expiredProof.expiresAt }), null);
    assert.equal(await deliveries.consume({ ...claim,ticketHash:expiredDelivery.ticketHash, now: expiredDelivery.expiresAt }), null);
    assert.equal(await proofs.discardExpired(now + 16000), 1);
    assert.equal(await deliveries.discardExpired(now + 16000), 1);
    await assert.rejects(proofs.insert({ ...proof, proofHash: digest(), expiresAt: now + 15001 }), /check constraint/);
    await assert.rejects(deliveries.insert({ ...delivery, ticketHash: digest(), expiresAt: now + 10001 }), /check constraint/);
    const columns = await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='design'`);
    assert.ok(columns.rows.every(row => !["proof", "ticket", "code", "result", "password", "token"].includes(row.column_name)));
  } finally {
    await database.end();
  }
});
