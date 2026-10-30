import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PostgresDatabase } from "../../../packages/persistence/src/postgres-database.mjs";
import { PostgresPhoneRepository } from "../src/virtual-phones/postgres-phone-repository.mjs";
import { PostgresPhoneAccessRepository } from "../src/virtual-phones/postgres-phone-access-repository.mjs";
import { PostgresPhoneMediaRoutes } from "../src/virtual-phones/managed-node-phone-media-bridge.mjs";
import { PHONE_SPEC, PHONE_POLICY } from "../src/virtual-phones/contracts.mjs";
import { VirtualPhoneService } from "../src/virtual-phones/virtual-phone-service.mjs";
import { PostgresPhoneCapacity } from "../../../services/scheduler/src/postgres-phone-capacity.mjs";
import { PostgresRealtimeReservationRepository } from "../../../services/scheduler/src/postgres-realtime-reservation-repository.mjs";
import { PostgresLeaseRepository } from "../../../services/scheduler/src/postgres-lease-repository.mjs";
import { phoneRuntimeResources } from "../../../services/scheduler/src/virtual-phone-capacity.mjs";
import { verifyPhoneStorageRegistration } from './helpers/phone-storage-postgres.mjs';
import { verifyPhoneRomMigration, verifyPhoneRomRequests, aospImage } from './helpers/phone-rom-postgres.mjs';

const require = createRequire(new URL("../../../packages/persistence/package.json", import.meta.url));
const { Pool } = require("pg");
const exec = promisify(execFile);
const docker = async (...args) => (await exec("docker", args, { timeout: 120_000, maxBuffer: 2 ** 20 })).stdout.trim();
const postgresImage = process.env.TEAMAIBOX_TEST_PHONE_POSTGRES_IMAGE
  || "sha256:83b9631dbb4121d9235ef910018272798b7d3041ef5b716aa481122d4c49353f";
const migrationRoot = new URL("../../../packages/persistence/migrations/", import.meta.url);
const fixedPostgresPort = process.env.TEAMAIBOX_TEST_PHONE_POSTGRES_PORT
  ? Number(process.env.TEAMAIBOX_TEST_PHONE_POSTGRES_PORT) : null;
if (fixedPostgresPort !== null && (!Number.isInteger(fixedPostgresPort) || fixedPostgresPort < 1024 || fixedPostgresPort > 65535)) {
  throw new Error("TEAMAIBOX_TEST_PHONE_POSTGRES_PORT must be an unprivileged TCP port");
}

// Opt-in creates its OWN tmpfs PostgreSQL. No DATABASE_URL or remote database is accepted.
test("virtual phone real PostgreSQL migrations and concurrent repository operations", {
  skip: process.env.TEAMAIBOX_TEST_PHONE_POSTGRES !== "1", timeout: 180_000,
}, async t => {
  const name = `teamaibox-phone-pg-test-${randomUUID()}`;
  let containerId, database;
  try {
    containerId = await docker("run", "-d", "--name", name, "--label", `teamaibox.phone-test=${name}`,
      "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=128",
      "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=536870912",
      "-p", `127.0.0.1:${fixedPostgresPort ?? ""}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=phone_test", postgresImage);
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const port = fixedPostgresPort ?? Number((await docker("port", containerId, "5432/tcp")).split(":").at(-1));
    const pool = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "phone_test", max: 12, connectionTimeoutMillis: 2000 });
    database = new PostgresDatabase({ pool });
    let ready = false;
    for (let n = 0; n < 60; n++) {
      try { await database.ready(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, "isolated PostgreSQL started");
    const manifest = JSON.parse(await readFile(new URL("manifest.json", migrationRoot), "utf8"));
    for (const migration of manifest.migrations.filter(m => m.version < 79)) {
      await database.transaction(async db => db.query(await readFile(new URL(migration.up, migrationRoot), "utf8")));
    }
    const owner = randomUUID(), other = randomUUID(), nodeId = randomUUID(), poolId = "phone-test-encrypted";
    for (const id of [owner, other]) await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,
      normalized_login_name,display_name,password_hash) VALUES ($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'test member','synthetic-test-hash')`, [id]);
    await database.query(`INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state)
      VALUES ($1,'phone-test-node','aarch64','managed_appliance','ready')`, [nodeId]);
    await database.query(`INSERT INTO objects.storage_pools(pool_id,display_name,backend_kind,node_id,failure_domain,
      health_state,total_bytes,available_bytes,encryption_mode,encryption_status,encryption_verified_at,
      compatibility_status,compatibility_verified_at) VALUES ($1,'synthetic encrypted pool','local-block',$2,'phone-test',
      'healthy',1099511627776,1099511627776,'luks2','verified',clock_timestamp(),'verified',clock_timestamp())`, [poolId, nodeId]);
    // Fixtures exercise DB constraints only: this is not evidence of an actual encrypted disk.
    const existing = (await database.query(`SELECT to_jsonb(i) AS value FROM iam.identities i ORDER BY id`)).rows;
    await database.transaction(async db => db.query(await readFile(new URL("000079_virtual_phones.up.sql", migrationRoot), "utf8")));
    assert.deepEqual((await database.query(`SELECT to_jsonb(i) AS value FROM iam.identities i ORDER BY id`)).rows, existing);
    // Empty down/up roundtrip proves additive schema compatibility; never applied to a populated product DB.
    await database.transaction(async db => db.query(await readFile(new URL("000079_virtual_phones.down.sql", migrationRoot), "utf8")));
    await database.transaction(async db => db.query(await readFile(new URL("000079_virtual_phones.up.sql", migrationRoot), "utf8")));
    const repository = new PostgresPhoneRepository({ database }), placement = { nodeId, poolId };
    for (const version of ['000085_phone_administrator_quotas', '000087_phone_resource_quotas']) {
      await database.transaction(async db => db.query(await readFile(new URL(`${version}.up.sql`, migrationRoot), 'utf8')));
    }
    for (const direction of ["up", "down", "up"]) await database.transaction(async db => db.query(
      await readFile(new URL(`000080_virtual_phone_administration.${direction}.sql`, migrationRoot), "utf8")));
    // Phone admission is deliberately tested against every current shared
    // capacity source.  These additive schemas landed after the phone schema;
    // install them in this isolated fixture so the test exercises the same
    // reservation union as the product database rather than an obsolete
    // phone-only snapshot.
    for (const version of ["000100_virtual_computers", "000104_fleet_service_reservations"]) {
      await database.transaction(async db => db.query(await readFile(new URL(`${version}.up.sql`, migrationRoot), "utf8")));
    }
    await t.test("ROM migration preserves existing AOSP identities and actual runtime versions", () => verifyPhoneRomMigration(database, { owner, nodeId, poolId }));
    await t.test("ROM requests pin immutable versions, preserve retries and share quota", () => verifyPhoneRomRequests(database, repository, placement));
    await t.test("feature switch survives service reconstruction; concurrent changes cannot overwrite one another", async () => {
      assert.equal(await repository.featurePolicy(), null);
      const writes = await Promise.allSettled(Array.from({ length: 8 }, () => repository.setFeaturePolicy(owner, { enabled: false, expectedRevision: 0 })));
      assert.equal(writes.filter(x => x.status === "fulfilled").length, 1);
      assert.ok(writes.filter(x => x.status === "rejected").every(x => x.reason.code === "phone_state_conflict"));
      assert.deepEqual(await new PostgresPhoneRepository({ database }).featurePolicy(), { enabled: false, revision: 1 });
      await assert.rejects(database.transaction(async db => db.query(await readFile(new URL("000080_virtual_phone_administration.down.sql", migrationRoot), "utf8"))));
      await repository.setFeaturePolicy(owner, { enabled: true, expectedRevision: 1 });
      assert.deepEqual(await repository.featurePolicy(), { enabled: true, revision: 2 });
    });
    await t.test("administrator quota list contains no phones or media credentials and uses literal bounded search", async () => {
      const page = await repository.administrationQuotas({ search: "test member" });
      assert.equal(page.data.length, 2); assert.equal(page.nextCursor, null);
      assert.deepEqual(Object.keys(page.data[0]).sort(), ["ownerId", "displayName", "loginName", "status", "storedPerUser", "runningPerUser", "revision", "stored", "running"].sort());
      assert.equal((await repository.administrationQuotas({ search: "%" })).data.length, 0);
      // Keep the same search when paging; migration fixtures also create
      // identities, whose random UUIDs must not affect this filtered page.
      assert.equal((await repository.administrationQuotas({ search: "test member", after: page.data[0].ownerId })).data.length, 1);
      const current = page.data.find(x => x.ownerId === owner);
      const update = { storedPerUser: 2, runningPerUser: 2, expectedRevision: current.revision };
      const changed = await repository.setQuota(owner, update);
      assert.equal(changed.revision, 2);
      await assert.rejects(repository.setQuota(owner, update), { code: "phone_state_conflict" });
    });
    const create = (key, name = key, who = owner) => repository.requestCreate({ ownerId: who, input: { name, start: false }, key, placement });
    const finishCreate = async op => {
      const phone = await repository.get(op.ownerId, op.phoneId);
      return repository.completeOperation({ ownerId: op.ownerId, operationId: op.id, generation: op.generation,
        result: { storageReady: true, volumeId: phone.volumeId } });
    };
    let first, second;
    await t.test("12 concurrent identical requests return one phone and operation", async () => {
      const values = await Promise.all(Array.from({ length: 12 }, () => create("same-key-0001")));
      assert.equal(new Set(values.map(value => value.id)).size, 1);
      assert.equal((await repository.list(owner)).length, 1);
      first = values[0];
      await assert.rejects(create("same-key-0001", "different name"), { code: "phone_idempotency_conflict" });
      await finishCreate(first);
    });
    await t.test("concurrent claims of the last stored slot cannot overallocate", async () => {
      const values = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => create(`last-slot-${i}`)));
      assert.equal(values.filter(v => v.status === "fulfilled").length, 1);
      assert.ok(values.filter(v => v.status === "rejected").every(v => v.reason.code === "phone_stored_quota"));
      second = values.find(v => v.status === "fulfilled").value;
      await finishCreate(second);
      assert.equal((await repository.quota(owner)).stored, 2);
    });
    await t.test("owner scope denies another member for phone, operation, rename and start", async () => {
      for (const action of [() => repository.get(other, first.phoneId), () => repository.getOperation(other, first.id),
        () => repository.rename({ ownerId: other, phoneId: first.phoneId, input: { name: "stolen", expectedRevision: 2 } }),
        () => repository.requestAction({ ownerId: other, phoneId: first.phoneId, action: "start", key: "other-start-1", input: { expectedRevision: 2 } })]) {
        await assert.rejects(action(), { code: "phone_not_found" });
      }
      assert.deepEqual(await repository.list(other), []);
    });
    let start;
    await t.test("last running quota is serialized; retries and lifecycle conflicts are unambiguous", async () => {
      await repository.setQuota(owner, { storedPerUser: 2, runningPerUser: 1 });
      const values = await Promise.allSettled([first, second].map(op => repository.requestAction({ ownerId: owner,
        phoneId: op.phoneId, action: "start", key: `start-${op.phoneId}`, input: { expectedRevision: 2 } })));
      assert.equal(values.filter(v => v.status === "fulfilled").length, 1);
      assert.equal(values.find(v => v.status === "rejected").reason.code, "phone_running_quota");
      start = values.find(v => v.status === "fulfilled").value;
      assert.equal((await repository.quota(owner)).running, 1);
      assert.equal((await repository.requestAction({ ownerId: owner, phoneId: start.phoneId, action: "start",
        key: start.idempotencyKey, input: { expectedRevision: 2 } })).id, start.id);
      await assert.rejects(repository.requestAction({ ownerId: owner, phoneId: start.phoneId, action: "delete",
        key: "conflict-delete-1", input: { expectedRevision: 3, confirmDelete: true } }), { code: "phone_operation_conflict" });
    });
    let active;
    await t.test("run identity and generation fence late results; readiness is required", async () => {
      active = await repository.bindRun({ ownerId: owner, phoneId: start.phoneId, operationId: start.id,
        generation: start.generation, runId: randomUUID(), nodeGeneration: 1, reservationId: randomUUID(), imageDigest: aospImage });
      const result = { runId: active.id, androidReady: true, mediaReady: true, containerId: "b".repeat(64) };
      await assert.rejects(repository.completeOperation({ ownerId: owner, operationId: start.id, generation: start.generation - 1, result }), { code: "phone_stale_run" });
      await assert.rejects(repository.completeOperation({ ownerId: owner, operationId: start.id, generation: start.generation,
        result: { ...result, mediaReady: false } }), { code: "phone_runtime_unavailable" });
      assert.equal((await repository.get(owner, start.phoneId)).state, "starting");
      await repository.completeOperation({ ownerId: owner, operationId: start.id, generation: start.generation, result });
      assert.equal((await repository.get(owner, start.phoneId)).state, "running");
    });
    await t.test("media target resolution joins the actual phone and run schema with exact ownership",async()=>{
      const routes=new PostgresPhoneMediaRoutes({database,approvedNodes:[{nodeId,nodeGeneration:1,poolId,imageDigest:active.imageDigest,maximumPhones:2}]});
      const grant={id:randomUUID(),ownerId:owner,phoneId:start.phoneId,runId:active.id,generation:active.generation,sessionId:randomUUID(),kind:"control"};
      const target=await routes.resolve(grant,"open");
      assert.equal(target.nodeId,nodeId);assert.equal(target.payload.run.reservationId,active.reservationId);
      assert.equal(target.payload.volumeId,(await repository.get(owner,start.phoneId)).volumeId);
      for(const change of [{ownerId:other},{runId:randomUUID()},{generation:active.generation+1}])await assert.rejects(routes.resolve({...grant,...change},"renew"),{code:"phone_stale_run"});
    });
    await t.test("access records cannot bind another owner, login, generation or an unbounded lifetime", async () => {
      const ownerSession = randomUUID(), otherSession = randomUUID();
      for (const [sessionId, who, octet] of [[ownerSession, owner, 1], [otherSession, other, 2]]) {
        await database.query(`INSERT INTO iam.sessions(id,identity_id,token_hash,csrf_hash,password_version,user_agent_hash,network_hash,
          created_at,last_seen_at,idle_expires_at,expires_at) VALUES ($1,$2,$3,$3,1,$3,$3,
          clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '10 minutes')`,
        [sessionId, who, Buffer.alloc(32, octet)]);
      }
      let octet = 10;
      const add = (who = owner, sessionId = ownerSession, generation = active.generation, seconds = 30) => database.query(`
        INSERT INTO platform.phone_access_grants(id,phone_id,owner_id,run_id,generation,session_id,kind,token_hash,state,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'control',$7,'issued',clock_timestamp()+$8*interval '1 second') RETURNING id`,
      [randomUUID(), start.phoneId, who, active.id, generation, sessionId, Buffer.alloc(32, octet++), seconds]);
      await assert.rejects(add(owner, otherSession), { code: "23514" });
      await assert.rejects(add(other, otherSession), { code: "23503" });
      await assert.rejects(add(owner, ownerSession, active.generation + 1), { code: "23503" });
      await assert.rejects(add(owner, ownerSession, active.generation, 120), { code: "23514" });
      const grantId = (await add()).rows[0].id;
      await assert.rejects(add(), { code: "23505" });
      await assert.rejects(database.query(`UPDATE platform.phone_access_grants SET token_hash=$2 WHERE id=$1`,
        [grantId, Buffer.alloc(32, 99)]), { code: "23514" });
      await database.query(`UPDATE platform.phone_access_grants SET state='revoked',ended_at=clock_timestamp() WHERE id=$1`, [grantId]);
    });
    await t.test("real access transactions fence concurrent tickets, refresh, replay and revoked logins", async () => {
      const access=new PostgresPhoneAccessRepository({database}), sessionId=randomUUID(), secondSession=randomUUID();
      for (const [id,octet] of [[sessionId,80],[secondSession,81]]) await database.query(`INSERT INTO iam.sessions
        (id,identity_id,token_hash,csrf_hash,password_version,user_agent_hash,network_hash,created_at,last_seen_at,idle_expires_at,expires_at)
        VALUES($1,$2,$3,$3,1,$3,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '10 minutes')`,
      [id,owner,Buffer.alloc(32,octet)]);
      const scope={ownerId:owner,phoneId:start.phoneId,sessionId,kind:"control"};
      const values=await Promise.allSettled(Array.from({length:10},(_,i)=>access.issue({...scope,ttlSeconds:60,tokenHash:Buffer.alloc(32,100+i)})));
      assert.equal(values.filter(x=>x.status==="fulfilled").length,1);
      assert.ok(values.filter(x=>x.status==="rejected").every(x=>x.reason.code==="phone_connection_in_use"));
      const winner=values.findIndex(x=>x.status==="fulfilled"), ticket=values[winner].value;
      assert.equal(Object.hasOwn(ticket,"tokenHash"),false);
      const request={...scope,grantId:ticket.id,tokenHash:Buffer.alloc(32,100+winner)};
      await assert.rejects(access.consume({...request,sessionId:secondSession}),{code:"phone_grant_invalid"});
      await assert.rejects(access.consume({...request,tokenHash:Buffer.alloc(32,240)}),{code:"phone_grant_invalid"});
      const consumes=await Promise.allSettled(Array.from({length:12},()=>access.consume(request)));
      assert.equal(consumes.filter(x=>x.status==="fulfilled").length,1);
      assert.ok(consumes.filter(x=>x.status==="rejected").every(x=>x.reason.code==="phone_grant_invalid"));
      assert.equal((await access.active()).find(x=>x.id===ticket.id).authorized,true);
      assert.equal((await access.getActive(ticket.id)).authorized,true);
      // Repeated connection claims from a second login cannot revoke the
      // connected winner. Both same-login tabs and other logins are protected.
      for(const requestingSession of [sessionId,secondSession]){
        const retries=await Promise.allSettled(Array.from({length:12},()=>access.issue({...scope,sessionId:requestingSession,ttlSeconds:60,tokenHash:Buffer.alloc(32,199)})));
        assert.ok(retries.every(x=>x.status==="rejected"&&x.reason.code==="phone_connection_in_use"));
        assert.equal((await access.getActive(ticket.id)).state,"connected");
      }
      assert.equal(await access.getActive(randomUUID()),null);
      const revoking=await access.beginRevocation(scope);
      assert.equal(revoking.length,1);assert.equal(revoking[0].state,"revoking");
      await assert.rejects(access.issue({...scope,tokenHash:Buffer.alloc(32,200)}),{code:"phone_connection_in_use"});
      await assert.rejects(access.confirmRevoked({...ticket,runId:randomUUID()}),{code:"phone_grant_invalid"});
      await access.confirmRevoked(ticket);await access.confirmRevoked(ticket);
      // A one-second ticket is consumed once. Expiration of that handshake
      // ticket must NOT terminate an already authorized control connection.
      const next=await access.issue({...scope,ttlSeconds:1,tokenHash:Buffer.alloc(32,201)});
      await access.consume({...scope,grantId:next.id,tokenHash:Buffer.alloc(32,201)});
      await database.query("SELECT pg_sleep(1.1)");
      assert.equal((await access.active()).find(x=>x.id===next.id).authorized,true);
      await database.query(`UPDATE iam.sessions SET revoked_at=clock_timestamp(),revoke_reason='test-sign-out' WHERE id=$1`,[sessionId]);
      assert.equal((await access.active()).find(x=>x.id===next.id).authorized,false);
      await assert.rejects(access.issue({...scope,kind:"adb",tokenHash:Buffer.alloc(32,202)}),{code:"phone_grant_invalid"});
      for (const item of await access.beginRevocation(scope)) await access.confirmRevoked(item);
      const expired=await access.issue({...scope,sessionId:secondSession,ttlSeconds:1,tokenHash:Buffer.alloc(32,203)});
      await database.query("SELECT pg_sleep(1.1)");
      await assert.rejects(access.consume({...scope,sessionId:secondSession,grantId:expired.id,tokenHash:Buffer.alloc(32,203)}),{code:"phone_grant_invalid"});
      assert.equal((await access.active()).find(x=>x.id===expired.id).authorized,false);
      for (const item of await access.beginRevocation({...scope,sessionId:secondSession})) await access.confirmRevoked(item);
    });
    await t.test("unknown stop retains running quota; confirmed exact stop releases it", async () => {
      const current = await repository.get(owner, start.phoneId);
      const stop = await repository.requestAction({ ownerId: owner, phoneId: start.phoneId, action: "stop",
        key: "stop-key-0001", input: { expectedRevision: current.revision } });
      await assert.rejects(repository.completeOperation({ ownerId: owner, operationId: stop.id, generation: stop.generation,
        result: { runId: active.id, runtimeStopped: false } }), { code: "phone_stop_unconfirmed" });
      assert.equal((await repository.quota(owner)).running, 1);
      await repository.completeOperation({ ownerId: owner, operationId: stop.id, generation: stop.generation,
        result: { runId: active.id, runtimeStopped: true, cleanShutdown: true } });
      assert.equal((await repository.quota(owner)).running, 0);
      assert.equal(await repository.currentRun(owner, start.phoneId), null);
    });
    await t.test("old-owner foreign keys, immutable identity and transaction rollback are enforced by PostgreSQL", async () => {
      await assert.rejects(database.query(`UPDATE platform.phones SET owner_id=$2,revision=revision+1 WHERE id=$1`, [first.phoneId, other]), { code: "23514" });
      const before = await repository.get(owner, first.phoneId);
      await assert.rejects(database.transaction(async db => {
        await db.query(`UPDATE platform.phones SET name='rollback',revision=revision+1 WHERE id=$1`, [first.phoneId]);
        await db.query(`INSERT INTO platform.phone_operations(id,phone_id,owner_id,action,idempotency_key,request_fingerprint,generation)
          VALUES ($1,$2,$3,'stop','cross-owner-op',$4,1)`, [randomUUID(), first.phoneId, other, "c".repeat(64)]);
      }), { code: "23503" });
      assert.deepEqual(await repository.get(owner, first.phoneId), before);
      await assert.rejects(database.transaction(async db => db.query(await readFile(new URL("000079_virtual_phones.down.sql", migrationRoot), "utf8"))), { code: "23514" });
      assert.equal((await repository.list(owner)).length, 2);
    });
    await t.test("domain workflow persists create/auto-start, restart generation, rename and exact confirmed deletion", async () => {
      const events = [];
      let otherActive = true;
      const directory = { async authorization(id) { if (id === other && !otherActive) return null; return id === owner || id === other
        ? { permissions: ["phone:use", ...(id === owner ? ["phone:manage"] : [])] } : { permissions: ["phone:manage"] }; } };
      const runtime = {
        async provision({ phone }) { events.push("provision"); return { storageReady: true, volumeId: phone.volumeId }; },
        async start({ run }) { events.push("start"); return { runId: run.id, androidReady: true, mediaReady: true, containerId: "f".repeat(64) }; },
        async stop({ run }) { events.push("stop"); return { runId: run.id, runtimeStopped: true, cleanShutdown: true }; },
        async revokeAccess() { events.push("revoke"); },
        async deleteData({ phone }) { events.push("delete"); return { dataDeleted: true, volumeId: phone.volumeId }; },
      };
      const capacity = {
        async placement() { return placement; }, async status() { return []; }, async releaseRun() { events.push("release"); },
        async acquireRun({ phone, operation }) { return repository.bindRun({ ownerId: phone.ownerId, phoneId: phone.id,
          operationId: operation.id, generation: phone.generation, runId: randomUUID(), nodeGeneration: 1,
          reservationId: randomUUID(), imageDigest: aospImage }); },
      };
      // These runtime/capacity doubles verify the domain port only, NOT node placement or product Android acceptance.
      const options = { repository, directory, capacity, runtime, policy: { enabled: true } };
      let service = new VirtualPhoneService(options);
      const context = { identityId: other, permissions: ["phone:use"] };
      await assert.rejects(service.create({ context, key: "spoof-owner-1", input: { name: "new", ownerId: owner } }), { code: "phone_input_invalid" });
      const created = await service.create({ context, key: "domain-create-1", input: { name: "my phone" } });
      assert.deepEqual(events, [], "request persists intent without doing blocking runtime work");
      assert.equal((await service.get({ context, phoneId: created.phoneId })).state, "creating");
      await service.processPending();
      const afterCreate = await service.get({ context, phoneId: created.phoneId });
      assert.equal(afterCreate.state, "starting", "auto-start intent commits with storage completion");
      service = new VirtualPhoneService(options); // Control-plane instance replacement resumes durable intent.
      await service.processPending();
      const started = await service.get({ context, phoneId: created.phoneId });
      assert.equal(started.state, "running");
      assert.equal(started.generation, 1);
      assert.ok(!Object.hasOwn(started, "poolId") && !Object.hasOwn(started, "volumeId"));
      const restart = await service.action({ context, phoneId: started.id, action: "restart", key: "domain-restart-1", input: { expectedRevision: started.revision } });
      await service.processPending();
      assert.equal((await repository.getOperation(other, restart.id)).state, "queued");
      await service.processPending();
      const restarted = await service.get({ context, phoneId: started.id });
      assert.equal(restarted.state, "running"); assert.equal(restarted.generation, 2);
      assert.equal(restarted.id, started.id);
      const renamed = await service.rename({ context, phoneId: started.id, input: { expectedRevision: restarted.revision, name: "work phone" } });
      assert.equal(renamed.name, "work phone");
      const manager = { identityId: randomUUID(), permissions: ["phone:manage", "phone:use"] };
      await assert.rejects(service.get({ context: manager, phoneId: started.id }), { code: "phone_permission_required" });
      assert.equal((await service.administration({ context: manager })).contentAccessGranted, false);
      const beforeSignout = events.length;
      await service.handleSignOut({ context: { ...context, sessionId: randomUUID() } });
      assert.deepEqual(events.slice(beforeSignout), ["revoke"]);
      otherActive = false;
      await database.query(`UPDATE iam.identities SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1`, [other]);
      await service.reconcileAuthorization();
      await service.processPending();
      assert.equal((await repository.get(other, started.id)).state, "stopped", "disabled identity is stopped through retained operation");
      assert.equal((await repository.get(other, started.id)).name, "work phone", "disable does not delete data");
      await assert.rejects(service.list({ context }), { code: "phone_permission_required" });
      otherActive = true;
      await database.query(`UPDATE iam.identities SET status='active',disabled_at=NULL WHERE id=$1`, [other]);
      const stopped = await service.get({ context, phoneId: started.id });
      await service.action({ context, phoneId: started.id, action: "start", key: "enabled-start-1", input: { expectedRevision: stopped.revision } });
      await service.processPending();
      const deletionInput = { expectedRevision: (await service.get({ context, phoneId: started.id })).revision, confirmDelete: true };
      const deletion = await service.action({ context, phoneId: started.id, action: "delete", key: "domain-delete-1", input: deletionInput });
      await service.processPending();
      assert.equal((await service.getOperation({ context, operationId: deletion.id })).state, "succeeded");
      assert.deepEqual(events.slice(-4), ["revoke", "stop", "release", "delete"]);
      assert.equal((await service.list({ context })).data.length, 0);
      assert.equal((await service.action({ context, phoneId: started.id, action: "delete", key: "domain-delete-1", input: deletionInput })).id, deletion.id,
        "lost delete response retries remain idempotent after tombstone");
      assert.equal((await repository.list(owner)).length, 2, "other phones are untouched");
      const disabled = new VirtualPhoneService({ ...options, policy: { enabled: false } });
      assert.equal((await disabled.create({ context, key: "domain-create-1", input: { name: "my phone" } })).id, created.id,
        "lost create response still resolves after feature is disabled");
      await assert.rejects(disabled.create({ context, key: "domain-create-2", input: { name: "new phone" } }), { code: "phone_disabled" });
    });
    await t.test("auto-start quota refusal preserves created stopped phone and failed startup retains uncertain reservations", async () => {
      await repository.setQuota(other, { storedPerUser: 2, runningPerUser: 0 });
      const op = await repository.requestCreate({ ownerId: other, key: "autostart-limit-1", input: { name: "saved phone", start: true }, placement });
      await finishCreate(op);
      const saved = await repository.get(other, op.phoneId);
      assert.equal(saved.state, "stopped"); assert.equal(saved.errorCode, "phone_running_quota");
      await repository.setQuota(other, { storedPerUser: 2, runningPerUser: 2 });
      const startOp = await repository.requestAction({ ownerId: other, phoneId: saved.id, action: "start", key: "fail-start-0001",
        input: { expectedRevision: saved.revision } });
      const live = await repository.bindRun({ ownerId: other, phoneId: saved.id, operationId: startOp.id, generation: startOp.generation,
        runId: randomUUID(), nodeGeneration: 1, reservationId: randomUUID(), imageDigest: aospImage });
      await assert.rejects(repository.failOperation({ ownerId: other, operationId: startOp.id, generation: startOp.generation,
        error: new Error("untrusted diagnostic"), runtimeStopped: true }), { code: "phone_stop_unconfirmed" });
      await repository.failOperation({ ownerId: other, operationId: startOp.id, generation: startOp.generation,
        error: new Error("untrusted diagnostic") });
      const failed = await repository.get(other, saved.id);
      assert.equal(failed.errorCode, "phone_runtime_unavailable"); assert.equal(failed.runningCharged, true);
      const stop = await repository.requestAction({ ownerId: other, phoneId: saved.id, action: "stop", key: "clean-failed-1",
        input: { expectedRevision: failed.revision } });
      await repository.completeOperation({ ownerId: other, operationId: stop.id, generation: stop.generation,
        result: { runId: live.id, runtimeStopped: true, cleanShutdown: false } });
      const stopped = await repository.get(other, saved.id);
      const remove = await repository.requestAction({ ownerId: other, phoneId: saved.id, action: "delete", key: "remove-failed-1",
        input: { expectedRevision: stopped.revision, confirmDelete: true } });
      await repository.completeOperation({ ownerId: other, operationId: remove.id, generation: remove.generation,
        result: { runtimeStopped: true, dataDeleted: true, volumeId: stopped.volumeId } });
    });
    await t.test("failed encrypted-storage admission leaves no phone or operation", async () => {
      const before = (await database.query("SELECT count(*)::integer AS n FROM platform.phone_operations")).rows[0].n;
      await database.query(`UPDATE objects.storage_pools SET health_state='unavailable' WHERE pool_id=$1`, [poolId]);
      await assert.rejects(create("storage-unavailable-1", "no plaintext", other), { code: "phone_storage_unavailable" });
      assert.equal((await repository.list(other)).length, 0);
      assert.equal((await database.query("SELECT count(*)::integer AS n FROM platform.phone_operations")).rows[0].n, before);
      await database.query(`UPDATE objects.storage_pools SET health_state='healthy',available_bytes=$2 WHERE pool_id=$1`, [poolId, PHONE_SPEC.storageBytes]);
      await assert.rejects(create("storage-full-0001", "no space", other), { code: "phone_storage_full" });
    });
    await t.test("disabled identities cannot create; existing data is retained", async () => {
      await database.query(`UPDATE iam.identities SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1`, [other]);
      await assert.rejects(create("disabled-owner-1", "denied", other), { code: "phone_permission_required" });
      assert.equal((await repository.list(owner)).length, 2);
    });
    await t.test("phone and existing realtime admissions serialize shared capacity in both directions", async () => {
      const aux = randomUUID(), who = randomUUID(), pool = `phone-capacity-${aux}`, image = aospImage;
      await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
        VALUES ($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'capacity member','synthetic-test-hash')`, [who]);
      const resources = { ...phoneRuntimeResources, unifiedMemoryBytes: 10 * 1024 ** 3, cpuMillis: 4000 };
      await database.query(`INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state,appliance_role,capacity)
        VALUES ($1,$2,'aarch64','managed_appliance','ready','appliance-core',$3::jsonb)`, [aux, `phone-capacity-${aux}`, JSON.stringify(resources)]);
      await database.query(`INSERT INTO objects.storage_pools(pool_id,display_name,backend_kind,node_id,failure_domain,
        health_state,total_bytes,available_bytes,encryption_mode,encryption_status,encryption_verified_at,
        compatibility_status,compatibility_verified_at) VALUES ($1,'DB-only fixture','local-block',$2,'phone-capacity',
        'healthy',1099511627776,1099511627776,'luks2','verified',clock_timestamp(),'verified',clock_timestamp())`, [pool, aux]);
      const now = new Date(), approvedNodes = [{ nodeId: aux, nodeGeneration: 1, imageDigest: image, poolId: pool, maximumPhones: 2 }];
      // Synthetic metrics exercise admission math; this is NOT an actual node/KVM/storage acceptance.
      let baseline = { nodeId: aux, nodeGeneration: 1, kvmApiVersion: 12, samples: Array.from({ length: 7 }, (_, i) => ({
        observedAt: new Date(+now - (6 - i) * 5000), availableBytes: 64 * 1024 ** 3, psiSomeAverage10: 0, swapOutBytes: 0, workers: [],
      })) };
      const capacity = new PostgresPhoneCapacity({ database, localNodeId: aux, approvedNodes, baselineProvider: { read: async () => baseline }, clock: () => now });
      assert.equal((await capacity.status())[0].reasonCode, null);
      assert.deepEqual(await capacity.placement(), { nodeId: aux, poolId: pool });
      const createStart = async key => {
        const made = await repository.requestCreate({ ownerId: who, key: `capacity-create-${key}`, input: { name: key, start: false }, placement: { nodeId: aux, poolId: pool } });
        await finishCreate(made);
        const stopped = await repository.get(who, made.phoneId);
        const operation = await repository.requestAction({ ownerId: who, phoneId: stopped.id, action: "start", key: `capacity-start-${key}`, input: { expectedRevision: stopped.revision } });
        return { phone: await repository.get(who, made.phoneId), operation, policy: PHONE_POLICY };
      };
      const pending = await createStart("one"), pending2 = await createStart("two");
      const realtime = new PostgresRealtimeReservationRepository({ database });
      const admit = () => realtime.acquireRealtimeReservation({ sessionId: randomUUID(), admissionKey: randomUUID(), ownerIdentityId: who,
        correlationId: "phone-realtime-race", capability: "webrtc-gateway", requestedModel: null, modelProfileId: null,
        nodeId: aux, nodeGeneration: 1, route: "managed_node", latencyBudgetMilliseconds: 250,
        resources: { ...phoneRuntimeResources, networkBitsPerSecond: 0 }, codecDirections: { encodeSessions: 0, decodeSessions: 0 },
        leaseToken: randomUUID(), admittedAt: now, connectionDeadlineAt: new Date(+now + 30_000), expiresAt: new Date(+now + 60_000) });
      const rt = await admit();
      await assert.rejects(capacity.acquireRun(pending), { code: "phone_capacity_unavailable" });
      assert.equal((await database.query(`SELECT count(*)::integer AS n FROM compute.phone_resource_reservations WHERE node_id=$1`, [aux])).rows[0].n, 0);
      await realtime.releaseRealtimeSession({ ownerIdentityId: who, sessionId: rt.sessionId, connectionId: null, reason: "client_closed", releasedAt: now });
      const leases = new PostgresLeaseRepository({ database });
      const jobAdmissions = [];
      for (const modality of ["chat", "agent"]) {
        const capability = randomUUID(), profile = randomUUID(), job = randomUUID();
        await database.query(`INSERT INTO compute.capabilities(id,capability_key,modality,contract_version,api_operations)
          VALUES ($1,$2,$3,'v1','[]')`, [capability, `phone-test-${modality}`, modality]);
        await database.query(`INSERT INTO compute.model_profiles(id,profile_key,capability_id,source_model,source_revision,
          engine,engine_version,precision,artifact_digest,compatibility,declared_resources,certification_state)
          VALUES ($1,$2,$3,$2,'test','fixture','1','bf16',$4,'{}','{}','certified')`, [profile, `phone-test-${modality}`, capability, image]);
        await database.query(`INSERT INTO compute.jobs(id,owner_identity_id,capability_id) VALUES ($1,$2,$3)`, [job, who, capability]);
        // DB-only job/profile fixtures verify shared accounting, not a real model/Agent run.
        const request = () => leases.acquireLeaseSet({ acquisitionKey: randomUUID(), jobId: job, nodeId: aux, nodeGeneration: 1,
          modelProfileId: profile, nodeExclusive: false, reservation: { ...phoneRuntimeResources, networkBitsPerSecond: 0 },
          attemptId: randomUUID(), leaseToken: randomUUID(), acquiredAt: now, expiresAt: new Date(+now + 60_000) });
        const activeLease = await request();
        await assert.rejects(capacity.acquireRun(pending), { code: "phone_capacity_unavailable" });
        await leases.releaseLeaseSet({ leaseToken: activeLease.leaseToken, fencingToken: activeLease.fencingToken, reason: "test_complete", releasedAt: now });
        jobAdmissions.push(request);
      }
      const simultaneous = await Promise.allSettled([capacity.acquireRun(pending), admit()]);
      assert.equal(simultaneous.filter(row => row.status === "fulfilled").length, 1, "phone and media cannot both claim the last memory");
      let run;
      if (simultaneous[0].status === "rejected") {
        const live = simultaneous[1].value;
        await realtime.releaseRealtimeSession({ ownerIdentityId: who, sessionId: live.sessionId, connectionId: null, reason: "client_closed", releasedAt: now });
        run = await capacity.acquireRun(pending);
      } else run = simultaneous[0].value;
      assert.equal((await capacity.acquireRun(pending)).id, run.id, "retry reuses the committed run");
      await assert.rejects(admit(), { code: "lease_capacity_exhausted" });
      for (const request of jobAdmissions) await assert.rejects(request(), { code: "lease_capacity_exhausted" });
      await database.query(`UPDATE compute.nodes SET capacity=$2::jsonb WHERE id=$1`, [aux,
        JSON.stringify({ ...resources, unifiedMemoryBytes: 12 * 1024 ** 3, networkBitsPerSecond: 20_000_000 })]);
      await assert.rejects(capacity.acquireRun(pending2), { code: "phone_capacity_unavailable" });
      await repository.completeOperation({ ownerId: who, operationId: pending.operation.id, generation: pending.operation.generation,
        result: { runId: run.id, androidReady: true, mediaReady: true, containerId: "9".repeat(64) } });
      const healthy = baseline;
      baseline = { ...healthy, kvmApiVersion: 0 };
      await assert.rejects(capacity.acquireRun(pending2), { code: "phone_capacity_unavailable" });
      baseline = healthy;
      const run2 = await capacity.acquireRun(pending2);
      assert.equal((await capacity.status())[0].running, 2);
      await assert.rejects(capacity.releaseRun({ phone: pending.phone, run, stopResult: { runtimeStopped: false, runId: run.id } }), { code: "phone_stop_unconfirmed" });
      assert.equal((await capacity.status())[0].running, 2, "unconfirmed stop never releases capacity");
      for (const [input, value] of [[pending, run], [pending2, run2]]) await capacity.releaseRun({ phone: input.phone, run: value,
        stopResult: { runtimeStopped: true, runId: value.id, cleanShutdown: true } });
      assert.equal((await capacity.status())[0].running, 0);
      const after = await admit();
      await realtime.releaseRealtimeSession({ ownerIdentityId: who, sessionId: after.sessionId, connectionId: null, reason: "client_closed", releasedAt: now });
      await database.query(`UPDATE compute.nodes SET appliance_role='appliance-core' WHERE id=$1`, [aux]);
      assert.equal((await capacity.status())[0].reasonCode, null,
        "a healthy primary appliance remains an Android target for the single-box product baseline");
      assert.deepEqual(await capacity.placement(), { nodeId: aux, poolId: pool });
    });
    await t.test("node protection reconciles only the stopped phone and recovers a crash after capacity release", async () => {
      const who = randomUUID(), imageDigest = aospImage, events = [], protectedRuns = new Set();
      await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
        VALUES ($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'protection test member','synthetic-test-hash')`, [who]);
      await database.query(`UPDATE objects.storage_pools SET available_bytes=1099511627776 WHERE pool_id=$1`, [poolId]);
      const actualCapacity = new PostgresPhoneCapacity({ database, localNodeId: nodeId,
        approvedNodes: [{ nodeId, nodeGeneration: 1, poolId, imageDigest, maximumPhones: 2 }],
        baselineProvider: { read() { assert.fail("DB reconciliation test must not claim actual node admission"); } } });
      const capacity = { async placement() { return placement; }, async status() { return []; },
        async acquireRun({ phone, operation }) { return repository.bindRun({ ownerId: who, phoneId: phone.id, operationId: operation.id,
          generation: operation.generation, runId: randomUUID(), reservationId: randomUUID(), nodeGeneration: 1, imageDigest }); },
        async releaseRun(input) { events.push(["release",input.run.id]); return actualCapacity.releaseRun(input); } };
      const runtime = {
        async provision({ phone }) { return { storageReady: true, volumeId: phone.volumeId }; },
        async start({ run }) { events.push(["start",run.id]); return { runId: run.id, androidReady: true, mediaReady: true, containerId: "e".repeat(64) }; },
        async inspect({ run }) { return { runId: run.id, generation: run.generation, runtimeStopped: protectedRuns.has(run.id) }; },
        async stop({ run }) { events.push(["stop",run.id]); assert.ok(protectedRuns.has(run.id));
          return { runId: run.id, generation: run.generation, runtimeStopped: true, cleanShutdown: true, protectionReason: "memory_pressure" }; },
        async revokeAccess({ run }) { events.push(["revoke",run.id]); },
        async deleteData() { assert.fail("resource protection cannot delete phone data"); },
      };
      const settings = { repository, capacity, runtime, directory: { async authorization() { return { permissions: ["phone:use"] }; } }, policy: { enabled: true } };
      const service = new VirtualPhoneService(settings), made = [];
      for (const name of ["older", "newer"]) {
        const op = await service.create({ context: { identityId: who }, input: { name, start: false }, key: `protect-create-${name}` });
        await service.processOperation(who,op.id);
        const phone = await repository.get(who,op.phoneId);
        const start = await service.action({ context: { identityId: who }, phoneId: phone.id, action: "start",
          input: { expectedRevision: phone.revision }, key: `protect-start-${name}` });
        await service.processOperation(who,start.id);
        made.push({ phone: await repository.get(who,phone.id), run: await repository.currentRun(who,phone.id) });
      }
      // The Android driver is an explicit fixture; the domain/database/stop
      // accounting path is real and uses the same release transaction as deploy.
      protectedRuns.add(made[1].run.id);
      const isolatedService = new VirtualPhoneService({ ...settings, repository: new Proxy(repository, {
        get(target, key) { if (key === "chargedOwners") return async () => [who]; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; }
      }) });
      assert.equal((await isolatedService.reconcileRuntime()).stopping,1);
      assert.equal((await repository.quota(who)).running,2,"observation alone does not release");
      const pending = (await repository.pendingOperations()).find(op => op.ownerId===who);
      await isolatedService.processOperation(who,pending.id);
      assert.equal((await repository.quota(who)).running,1);
      const stopped = await repository.get(who,made[1].phone.id);
      assert.equal(stopped.state,"stopped");assert.equal(stopped.errorCode,"phone_resource_protection");
      assert.equal((await repository.get(who,made[0].phone.id)).state,"running");
      assert.deepEqual(events.slice(-3),["revoke","stop","release"].map(kind=>[kind,made[1].run.id]));
      await assert.rejects(repository.latestRun(other,made[1].phone.id),{code:"phone_not_found"});
      protectedRuns.add(made[0].run.id);
      const stopOp = await service.action({ context: { identityId: who }, phoneId: made[0].phone.id, action: "stop",
        input: { expectedRevision: made[0].phone.revision }, key: "protect-release-crash" });
      await repository.markExecuting(who,stopOp.id);
      await actualCapacity.releaseRun({ ...made[0], stopResult: { runId: made[0].run.id, runtimeStopped: true, cleanShutdown: true } });
      assert.equal(await repository.currentRun(who,made[0].phone.id),null);
      assert.equal((await repository.quota(who)).running,1);
      await new VirtualPhoneService(settings).processOperation(who,stopOp.id);
      assert.equal((await repository.quota(who)).running,0);
      assert.equal((await repository.get(who,made[0].phone.id)).errorCode,"phone_resource_protection");
      assert.equal((await repository.latestRun(who,made[0].phone.id)).cleanShutdown,true);
      assert.equal(events.filter(([kind])=>kind==="start").length,2,"recovery must not restart Android");
    });
    await t.test("phone pool registration uses live authenticated observations and cannot receive object blobs", () => verifyPhoneStorageRegistration(database));
    await t.test("resource-based default permits more than two phones and preserves explicit zero quotas", async () => {
      const who = randomUUID();
      await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
        VALUES ($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'resource quota test','synthetic')`, [who]);
      assert.equal((await repository.quota(who)).storedPerUser, null);
      const made=[];
      for (let i=0;i<4;i++) {
        const op=await repository.requestCreate({ownerId:who,input:{name:`resource-${i}`,start:true},key:`resource-${i}`,placement});
        const p=await repository.get(who,op.phoneId);
        await repository.completeOperation({ownerId:who,operationId:op.id,generation:op.generation,result:{storageReady:true,volumeId:p.volumeId}});
        made.push(op.phoneId);
      }
      assert.deepEqual(await repository.quota(who),{storedPerUser:null,runningPerUser:null,stored:4,running:4,revision:1});
      await repository.setQuota(who,{storedPerUser:0,runningPerUser:0});
      await assert.rejects(repository.requestCreate({ownerId:who,input:{name:'blocked',start:false},key:'resource-blocked',placement}),{code:'phone_stored_quota'});
      assert.equal((await repository.quota(who)).running,4,'quota edits do not stop existing phones');
      await repository.setQuota(who,{storedPerUser:null,runningPerUser:null});
      assert.equal((await repository.quota(who,{...PHONE_POLICY,storedPerUser:2})).storedPerUser,null,'explicit null is not replaced by fallback');
    });
    await t.test("casting schema admits nine authorized viewers and keeps audience revocation", async () => {
      await database.query(await readFile(new URL('000086_casting_viewer_count.up.sql',migrationRoot),'utf8'));
      let fixture=await readFile(new URL('../tests/wireless_casting_control_plane_smoke.sql',migrationRoot),'utf8');
      const old=/        IF current_index <= 7 THEN[\s\S]*?        END IF;\n    END LOOP;/;
      assert.match(fixture,old);
      fixture=fixture.replace(old,`        UPDATE platform.cast_viewer_grants SET grant_state='joined',revision=2,joined_at=clock_timestamp() WHERE id=grant_id;
    END LOOP;`).replace(') <> 8 THEN',') <> 9 THEN').replace(/^\\set .*\n/m,'').replace(/^BEGIN;\s*/m,'').replace(/^ROLLBACK;\s*$/m,'');
      await database.transaction(async db => {await db.query(fixture);});
    });
  } finally {
    await database?.close();
    if (containerId) {
      const inspected = JSON.parse(await docker("inspect", containerId))[0];
      assert.equal(inspected.Config.Labels["teamaibox.phone-test"], name);
      assert.equal(inspected.Name, `/${name}`);
      await docker("rm", "-f", containerId);
      assert.equal(await docker("ps", "-aq", "--filter", `label=teamaibox.phone-test=${name}`), "");
    }
  }
});
