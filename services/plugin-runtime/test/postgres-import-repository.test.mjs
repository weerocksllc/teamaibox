import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPluginImportRepository } from "../src/postgres-import-repository.mjs";

const hex = (character) => `sha256:${character.repeat(64)}`;
const bytes = (character) => Buffer.from(character.repeat(64), "hex");

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    pluginId: "example.team-notes",
    pluginType: "ApplicationPlugin",
    version: "1.2.3",
    sourceKind: "offline-bundle",
    manifest: { id: "example.team-notes", type: "ApplicationPlugin", version: "1.2.3", signature: {} },
    manifestPayloadDigest: hex("1"),
    manifestSignerKeyId: "example.publisher/release-2026",
    bundlePayloadDigest: hex("2"),
    bundleSignerKeyId: "example.publisher/release-2026",
    imageDigests: [hex("a")],
    artifacts: [{ name: "image-notes-app", digest: hex("a") }],
    supplyChain: {
      sbomDigest: hex("b"),
      provenanceDigest: hex("c"),
      vulnerabilityReportDigest: hex("d"),
      vulnerabilityStatus: "passed",
      vulnerabilityScannedAt: "2026-08-11T00:00:00.000Z",
    },
    policyVersion: 1,
    state: "verified",
    verifiedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function row(value = record()) {
  return {
    plugin_key: value.pluginId,
    plugin_type: value.pluginType,
    version: value.version,
    source_kind: value.sourceKind,
    manifest: value.manifest,
    manifest_payload_sha256: bytes("1"),
    manifest_signer_key_id: value.manifestSignerKeyId,
    bundle_payload_sha256: bytes("2"),
    bundle_signer_key_id: value.bundleSignerKeyId,
    image_digests: value.imageDigests,
    artifacts: value.artifacts,
    supply_chain: value.supplyChain,
    policy_version: value.policyVersion,
    state: value.state,
    verified_at: value.verifiedAt,
  };
}

test("PostgreSQL verified import atomically persists the full manifest and bounded supply-chain evidence", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          return { rows: [row()] };
        },
      });
    },
  };
  const repository = new PostgresPluginImportRepository({ database });
  const saved = await repository.saveVerified(record());
  assert.deepEqual(saved, record());
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO plugins\.verified_imports/);
  assert.match(calls[0].sql, /ON CONFLICT \(plugin_key, version\) DO NOTHING/);
  assert.equal(calls[0].parameters[4], JSON.stringify(record().manifest));
  assert.equal(calls[0].parameters[5].toString("hex"), "1".repeat(64));
  assert.equal(calls[0].parameters[7].toString("hex"), "2".repeat(64));
});

test("PostgreSQL verified import is idempotent only for identical signed content", async () => {
  let selected = row();
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      let call = 0;
      return operation({
        async query(sql) {
          call += 1;
          if (call === 1) return { rows: [] };
          assert.match(sql, /FOR UPDATE/);
          return { rows: [selected] };
        },
      });
    },
  };
  const repository = new PostgresPluginImportRepository({ database });
  assert.deepEqual(await repository.saveVerified(record()), record());
  selected = { ...selected, manifest_payload_sha256: bytes("3") };
  await assert.rejects(
    repository.saveVerified(record()),
    (error) => error.code === "plugin_version_conflict",
  );
});

test("PostgreSQL verified import repository requires transactional storage", () => {
  assert.throws(() => new PostgresPluginImportRepository({ database: {} }), /transaction/);
});
