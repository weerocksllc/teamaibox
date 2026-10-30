import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FilesystemBlobStore } from "../src/filesystem-blob-store.mjs";
import { PostgresEnvelopeMetadataRepository } from "../src/postgres-envelope-metadata-repository.mjs";
import { PostgresObjectGrantRepository } from "../src/postgres-object-grant-repository.mjs";
import { PostgresObjectRepository } from "../src/postgres-object-repository.mjs";


const BLOB = "objects/019c1f07-c1c4-7be8-b57e-6c0a999a8847";
const REFERENCE = "019c1f07-c1c4-7be8-b57e-6c0a999a8848";
const OBJECT = "019c1f07-c1c4-7be8-b57e-6c0a999a8849";
const OWNER = "019c1f07-c1c4-7be8-b57e-6c0a999a8850";


test("filesystem blob store persists only bounded raw ciphertext paths and lists stable blob identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-object-"));
  try {
    const store = new FilesystemBlobStore({ root });
    const ciphertext = Buffer.from("ciphertext-only");
    await store.put(BLOB, ciphertext);
    assert.deepEqual(await store.get(BLOB), ciphertext);
    assert.equal((await store.list())[0].blobKey, BLOB);
    assert.equal(await readFile(join(root, BLOB), "utf8"), "ciphertext-only");
    await assert.rejects(() => store.put("../escape", ciphertext), /key is invalid/);
    assert.equal(await store.delete(BLOB), true);
    assert.equal(await store.get(BLOB), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("PostgreSQL envelope metadata adapter binds immutable binary metadata and CAS revision", async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO objects.encrypted_blobs")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE objects.encrypted_blobs")) return { rows: [], rowCount: 1 };
      if (sql.includes("count(*)")) return { rows: [{ count: "1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresEnvelopeMetadataRepository({ database });
  const record = {
    schemaVersion: 1, blobKey: BLOB, revision: 1,
    plaintextSize: 8, plaintextSha256: "a".repeat(64), ciphertextSize: 8, ciphertextSha256: "b".repeat(64),
    dataEncryption: { algorithm: "aes-256-gcm", nonce: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64") },
    keyEnvelope: { algorithm: "aes-256-gcm-keywrap", keyVersion: 1, nonce: Buffer.alloc(12).toString("base64"), ciphertext: Buffer.alloc(32).toString("base64"), tag: Buffer.alloc(16).toString("base64") },
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  };
  assert.equal(await repository.putIfAbsent(record), true);
  assert.equal(await repository.compareAndSwap(BLOB, 1, { ...record, revision: 2, keyEnvelope: { ...record.keyEnvelope, keyVersion: 2 } }), true);
  assert.equal(await repository.countByKeyVersion(2), 1);
  assert.equal(calls[0].values[4].byteLength, 32);
  assert.equal(calls[1].values.at(-1), 1);
});


test("PostgreSQL object grant adapter persists immutable audience and records bounded use", async () => {
  const calls = [];
  const row = {
    reference_id: REFERENCE, namespace_key: `user:${OWNER}`, object_id: OBJECT, object_version: 1,
    audience: "messaging.attachment", operations: ["head", "read", "range"], integrity_sha256: Buffer.alloc(32, 7),
    issued_by_identity_id: OWNER, created_at: new Date("2026-08-12T00:00:00Z"), expires_at: new Date("2026-08-12T00:10:00Z"),
    revoked_at: null, revoked_by_identity_id: null, revoke_reason: null, last_used_at: null, use_count: "0",
  };
  const database = { async query(sql, values) { calls.push({ sql, values }); return { rows: [row], rowCount: 1 }; } };
  const repository = new PostgresObjectGrantRepository({ database });
  const created = await repository.create({
    referenceId: REFERENCE, namespaceKey: row.namespace_key, objectId: OBJECT, objectVersion: 1,
    audience: row.audience, operations: row.operations, integritySha256: "07".repeat(32), issuedByIdentityId: OWNER,
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: null, revokedByIdentityId: null,
    revokeReason: null, lastUsedAt: null, useCount: 0,
  });
  assert.equal(created.audience, "messaging.attachment");
  await repository.recordUse(REFERENCE, { usedAt: new Date() });
  assert.ok(calls[1].sql.includes("use_count=use_count+1"));
});


test("PostgreSQL object repository requires transactions and persists namespace authorization facts", async () => {
  assert.throws(() => new PostgresObjectRepository({ database: { query() {} } }), /transactions/);
  const calls = [];
  const database = {
    async query() { return { rows: [], rowCount: 0 }; },
    async transaction(operation) { return operation({ async query(sql, values) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; } }); },
  };
  const repository = new PostgresObjectRepository({ database });
  assert.equal(repository.readonlyReclamationOrder, "claim-first");
  await repository.ensureNamespaceAccess({
    namespaceKey: `user:${OWNER}`, identityId: OWNER,
    operations: ["write", "read", "reference:create"],
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].sql.includes("objects.namespace_bindings"));
  assert.deepEqual(JSON.parse(calls[1].values[2]), ["read", "reference:create", "write"]);
});

test('object page uses one bounded query and only the latest version', async () => {
  const calls = [], created = new Date('2026-08-10T00:00:00Z'), updated = new Date('2026-08-12T00:00:00Z');
  const row = { id: OBJECT, namespace_key: 'user:alpha', object_key: 'reports/中.txt', created_at: created,
    deleted_at: null, purge_after: null, object_id: OBJECT, version: '7', blob_key: BLOB, size: '9',
    sha256: Buffer.alloc(32, 7), content_type: 'text/plain', created_by_identity_id: OWNER, version_created_at: updated };
  const repository = new PostgresObjectRepository({ database: {
    transaction() { assert.fail('listing must not start a write transaction'); },
    async query(sql, params) { calls.push({sql, params}); return { rows: [row] }; },
  } });
  const [item] = await repository.listObjects('user:alpha', { prefix: 'reports/', after: 'reports/a.txt', limit: 3 });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, ['user:alpha', 'reports/', 'reports/a.txt', 3]);
  assert.match(calls[0].sql, /object_key>\$3[\s\S]*ORDER BY object_key LIMIT \$4/);
  assert.match(calls[0].sql, /LEFT JOIN LATERAL[\s\S]*ORDER BY version DESC LIMIT 1/);
  assert.equal(item.createdAt.toISOString(), created.toISOString());
  assert.equal(item.versions.length, 1); assert.equal(item.versions[0].version, 7);
  assert.equal(item.versions[0].createdAt.toISOString(), updated.toISOString());
  await assert.rejects(repository.listObjects('user:alpha', { limit: 1002 }), /limit is invalid/);
  assert.equal(calls.length, 1);
  row.version = null;
  await assert.rejects(repository.listObjects('user:alpha'), { code: 'object_metadata_corrupt' });
});
