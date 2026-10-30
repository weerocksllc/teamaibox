import assert from "node:assert/strict";
import { mkdtemp, readFile, chmod, lstat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import util from "node:util";

import {
  EncryptedSecretStore,
  FileCiphertextBackend,
  MemoryCiphertextBackend,
  SecretError,
  loadDevelopmentMasterKey,
} from "../src/index.mjs";

const admin = {
  service: "platform-api",
  permissions: ["secrets:write", "secrets:rotate", "secrets:revoke", "secrets:metadata", "secrets:read"],
};

const reader = {
  service: "scheduler",
  permissions: ["secrets:read", "secrets:metadata"],
};

function key(fill = 7) {
  return Buffer.alloc(32, fill);
}

async function expectSecretError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SecretError);
    assert.equal(error.code, code);
    return true;
  });
}

test("stores only ciphertext and exposes redacted metadata", async () => {
  const backend = new MemoryCiphertextBackend();
  const audit = [];
  const store = new EncryptedSecretStore({
    masterKey: key(),
    backend,
    audit: async (event) => audit.push(event),
  });
  const plaintext = Buffer.from("provider-token-super-secret");

  const metadata = await store.putInitial(
    "provider.openai",
    plaintext,
    ["scheduler"],
    admin,
    { rotateAfter: "2026-09-01T00:00:00.000Z" },
  );
  const state = await backend.load("provider.openai");

  assert.equal(metadata.versions[0].value, "[REDACTED]");
  assert.equal(metadata.versions[0].rotateAfter, "2026-09-01T00:00:00.000Z");
  assert.equal(state.versions[0].encryption.algorithm, "aes-256-gcm");
  assert.equal(JSON.stringify(state).includes(plaintext.toString("utf8")), false);
  assert.equal(JSON.stringify(metadata).includes(plaintext.toString("utf8")), false);
  assert.equal(JSON.stringify(audit).includes(plaintext.toString("utf8")), false);
  assert.match(util.inspect(store), /\[REDACTED\]/);
  assert.deepEqual(JSON.parse(JSON.stringify(store)), {
    type: "EncryptedSecretStore",
    masterKey: "[REDACTED]",
  });
  store.close();
});

test("enforces service scope and reads only inside a zeroized callback", async () => {
  const store = new EncryptedSecretStore({ masterKey: key(), backend: new MemoryCiphertextBackend() });
  await store.putInitial("provider.token", Buffer.from("alpha"), ["scheduler"], admin);

  const seen = await store.withSecret("provider.token", reader, async (secret) => {
    assert.equal(secret.toString("utf8"), "alpha");
    return { authenticated: true };
  });
  assert.deepEqual(seen, { authenticated: true });

  await expectSecretError(
    store.withSecret(
      "provider.token",
      { service: "object-service", permissions: ["secrets:read"] },
      async () => null,
    ),
    "scope_denied",
  );
  await expectSecretError(
    store.withSecret("provider.token", reader, async (secret) => secret.toString("utf8")),
    "unsafe_return",
  );
  store.close();
});

test("rotates atomically and records version lineage", async () => {
  const store = new EncryptedSecretStore({ masterKey: key(), backend: new MemoryCiphertextBackend() });
  await store.putInitial("object.kek", Buffer.from("version-one"), ["object-service"], admin);
  const rotated = await store.rotate(
    "object.kek",
    Buffer.from("version-two"),
    ["object-service", "platform-api"],
    admin,
  );

  assert.equal(rotated.activeVersion, 2);
  assert.equal(rotated.revision, 2);
  assert.equal(rotated.versions[0].status, "retired");
  assert.ok(rotated.versions[0].retiredAt);
  assert.equal(rotated.versions[1].rotatedFrom, 1);
  assert.equal(rotated.versions[1].status, "active");
  const readContext = { service: "object-service", permissions: ["secrets:read"] };
  await store.withSecret("object.kek", readContext, async (secret) => {
    assert.equal(secret.toString("utf8"), "version-two");
    return null;
  });
  store.close();
});

test("revocation retires the active version and makes future reads fail closed", async () => {
  const store = new EncryptedSecretStore({ masterKey: key(), backend: new MemoryCiphertextBackend() });
  await store.putInitial("provider.revoked", Buffer.from("do-not-use"), ["scheduler"], admin);
  const revoked = await store.revoke("provider.revoked", admin);
  assert.equal(revoked.activeVersion, null);
  assert.equal(revoked.versions[0].status, "retired");
  await expectSecretError(store.withSecret("provider.revoked", reader, async () => null), "no_active_version");
  assert.equal((await store.revoke("provider.revoked", admin)).activeVersion, null);
  store.close();
});

test("reads an explicit retired version only inside the scoped zeroized callback", async () => {
  const audit = [];
  const store = new EncryptedSecretStore({
    masterKey: key(),
    backend: new MemoryCiphertextBackend(),
    audit: async (event) => audit.push(event),
  });
  await store.putInitial("object.kek", key(1), ["object-service"], admin);
  await store.rotate("object.kek", key(2), ["object-service"], admin);
  const readContext = { service: "object-service", permissions: ["secrets:read"] };
  let callbackKey;
  const result = await store.withSecretVersion("object.kek", 1, readContext, async (secret) => {
    callbackKey = secret;
    assert.deepEqual(secret, key(1));
    return { unwrapped: true };
  });

  assert.deepEqual(result, { unwrapped: true });
  assert.deepEqual(callbackKey, Buffer.alloc(32));
  assert.ok(audit.some((event) => event.operation === "secret.read_version"
    && event.version === 1 && event.success));
  await expectSecretError(
    store.withSecretVersion("object.kek", 99, readContext, async () => null),
    "version_not_found",
  );
  store.close();
});

test("rejects authentication with the wrong master key", async () => {
  const backend = new MemoryCiphertextBackend();
  const writer = new EncryptedSecretStore({ masterKey: key(1), backend });
  await writer.putInitial("cluster.join", Buffer.from("join-token"), ["scheduler"], admin);
  writer.close();

  const readerWithWrongKey = new EncryptedSecretStore({ masterKey: key(2), backend });
  await expectSecretError(
    readerWithWrongKey.withSecret("cluster.join", reader, async () => null),
    "decryption_failed",
  );
  readerWithWrongKey.close();
});

test("file backend persists protected records with restrictive permissions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "teamaibox-secrets-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "records");
  const backend = new FileCiphertextBackend(directory);
  const store = new EncryptedSecretStore({ masterKey: key(), backend });
  await store.putInitial("source.npm", Buffer.from("npm-password"), ["source-gateway"], admin);

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const filename = path.join(directory, files[0]);
  const contents = await readFile(filename, "utf8");
  const fileInfo = await lstat(filename);
  const directoryInfo = await lstat(directory);
  assert.equal(contents.includes("npm-password"), false);
  assert.equal(fileInfo.mode & 0o077, 0);
  assert.equal(directoryInfo.mode & 0o077, 0);

  const reopened = new EncryptedSecretStore({
    masterKey: key(),
    backend: new FileCiphertextBackend(directory),
  });
  await reopened.withSecret(
    "source.npm",
    { service: "source-gateway", permissions: ["secrets:read"] },
    async (secret) => {
      assert.equal(secret.toString("utf8"), "npm-password");
      return null;
    },
  );
  store.close();
  reopened.close();
});

test("development bootstrap is explicit, local, regular, private, and exactly 32 bytes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "teamaibox-key-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const filename = path.join(root, "master.key");
  await writeFile(filename, key(9), { mode: 0o600 });

  const loaded = await loadDevelopmentMasterKey(filename, {
    runtimeEnvironment: "development",
    explicitlyAllowed: true,
  });
  assert.deepEqual(loaded, key(9));
  loaded.fill(0);

  await expectSecretError(
    loadDevelopmentMasterKey(filename, {
      runtimeEnvironment: "production",
      explicitlyAllowed: true,
    }),
    "development_bootstrap_denied",
  );
  await chmod(filename, 0o644);
  await expectSecretError(
    loadDevelopmentMasterKey(filename, {
      runtimeEnvironment: "development",
      explicitlyAllowed: true,
    }),
    "unsafe_bootstrap",
  );
  await chmod(filename, 0o600);
  const link = path.join(root, "linked.key");
  await symlink(filename, link);
  await expectSecretError(
    loadDevelopmentMasterKey(link, {
      runtimeEnvironment: "development",
      explicitlyAllowed: true,
    }),
    "unsafe_bootstrap",
  );
  const shortKey = path.join(root, "short.key");
  await writeFile(shortKey, Buffer.alloc(31), { mode: 0o600 });
  await expectSecretError(
    loadDevelopmentMasterKey(shortKey, {
      runtimeEnvironment: "development",
      explicitlyAllowed: true,
    }),
    "invalid_master_key",
  );
});
