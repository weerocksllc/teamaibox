import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createPostgresDatabaseFromEnvironment,
  PostgresDatabase,
} from "../src/postgres-database.mjs";
import { errorResponse } from "../../observability/src/index.mjs";

test("known pre-query connection failures are sanitized, retryable 503s without SQL replay", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "57P03"]) {
    let calls = 0;
    const fail = async () => { calls++; throw Object.assign(new Error("private database hostname"), {code}); };
    const database = new PostgresDatabase({pool:{query:fail,connect:fail,end:async()=>{}}});
    for (const action of [() => database.query("SELECT 1"), () => database.transaction(() => assert.fail("must not start SQL"))]) {
      await assert.rejects(action, error => {
        const response = errorResponse(error);
        assert.equal(response.status,503);
        assert.equal(response.body.error.retryable,true);
        assert.equal(response.body.error.code,"database_temporarily_unavailable");
        assert.doesNotMatch(JSON.stringify(response),/private database hostname/);
        return true;
      });
    }
    assert.equal(calls,2);
  }
});

test("ambiguous connection loss and SQL errors are not marked safely retryable", async () => {
  for (const code of ["ECONNRESET", "23505", "42601", "28P01"]) {
    const original=Object.assign(new Error("query failed"),{code});
    const database=new PostgresDatabase({pool:{query:async()=>{throw original;},connect:async()=>{},end:async()=>{}}});
    await assert.rejects(()=>database.query("INSERT"), error=>error===original);
  }
});

test("commits one client-scoped transaction and releases the client", async () => {
  const calls = [];
  let released;
  const client = {
    async query(text, parameters = []) {
      calls.push([text, parameters]);
      return { rows: [{ value: 7 }] };
    },
    release(destroy) { released = destroy; },
  };
  const database = new PostgresDatabase({
    pool: {
      async query() { return { rows: [{ ready: 1 }] }; },
      async connect() { return client; },
      async end() {},
    },
  });
  const value = await database.transaction(async (transaction) => (
    await transaction.query("SELECT $1::integer AS value", [7])
  ).rows[0].value);
  assert.equal(value, 7);
  assert.deepEqual(calls, [
    ["BEGIN", []],
    ["SELECT $1::integer AS value", [7]],
    ["COMMIT", []],
  ]);
  assert.equal(released, undefined);
  assert.equal(await database.ready(), true);
});

test("rolls back and destroys a client after a failed transaction", async () => {
  const calls = [];
  let released;
  const database = new PostgresDatabase({
    pool: {
      async query() { return { rows: [] }; },
      async connect() {
        return {
          async query(text) { calls.push(text); },
          release(destroy) { released = destroy; },
        };
      },
      async end() {},
    },
  });
  await assert.rejects(database.transaction(async () => { throw new Error("operation failed"); }), /operation failed/);
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
  assert.equal(released, true);
});

test("exports one repeatable-read snapshot and closes it exactly once", async () => {
  const calls = [], releases = [];
  const client = {
    async query(text) {
      calls.push(text);
      if (text.startsWith("SELECT pg_export_snapshot")) return { rows: [{ snapshot_id: "00000003-0000001B-1", postgres_lsn: "1A/2B", started_at: "2026-08-19T01:02:03.000Z" }] };
      return { rows: [{ value: 7 }] };
    },
    release(value) { releases.push(value); },
  };
  const database = new PostgresDatabase({ pool: { async query() {}, async connect() { return client; }, async end() {} } });
  const snapshot = await database.beginConsistentSnapshot();
  assert.equal(snapshot.snapshotId, "00000003-0000001B-1");
  assert.equal(snapshot.postgresLsn, "1A/2B");
  assert.equal((await snapshot.query("SELECT 7")).rows[0].value, 7);
  await snapshot.finish("completed");
  await snapshot.finish("failed");
  assert.deepEqual(calls, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT pg_export_snapshot() AS snapshot_id,\n        pg_current_wal_lsn()::text AS postgres_lsn, clock_timestamp() AS started_at",
    "SELECT 7", "COMMIT"]);
  assert.deepEqual(releases, [undefined]);
  assert.throws(() => snapshot.query("SELECT 8"), /closed/);
});

test("builds a bounded pool from discrete settings and a protected password file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-postgres-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, "a-long-database-password-2026\n", { mode: 0o600 });
  let configuration;
  let listener;
  class Pool {
    constructor(value) { configuration = value; }
    on(name, callback) { listener = [name, callback]; }
    async query() { return { rows: [{ ready: 1 }] }; }
    async connect() { throw new Error("not used"); }
    async end() {}
  }
  const database = await createPostgresDatabaseFromEnvironment({
    PLATFORM_DATABASE_HOST: "postgres",
    PLATFORM_DATABASE_PASSWORD_FILE: passwordFile,
    PLATFORM_DATABASE_TLS_MODE: "disable",
  }, { PoolClass: Pool, onPoolError() {} });
  assert.equal(configuration.host, "postgres");
  assert.equal(configuration.database, "teamaibox");
  assert.equal(configuration.user, "teamaibox");
  assert.equal(configuration.ssl, false);
  assert.equal(configuration.max, 10);
  assert.equal(await configuration.password(), "a-long-database-password-2026");
  assert.equal(listener[0], "error");
  await database.close();
  await assert.rejects(database.query("SELECT 1"), /closed/);
});

test("requires verified TLS by default and rejects password-bearing URLs", async () => {
  await assert.rejects(createPostgresDatabaseFromEnvironment({
    PLATFORM_DATABASE_HOST: "postgres",
    PLATFORM_DATABASE_PASSWORD_FILE: "/run/secrets/postgres-password",
  }, { PoolClass: class {} }), /PLATFORM_DATABASE_CA_FILE/);
  await assert.rejects(createPostgresDatabaseFromEnvironment({
    PLATFORM_DATABASE_URL: "postgres://user:secret@postgres/db",
  }, { PoolClass: class {} }), /URLs are not accepted/);
});
