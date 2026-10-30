import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const load = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Team Drive contracts keep hierarchy and versions separate from reusable object credentials", async () => {
  const catalog = await load("catalog.v1.json");
  const expected = {
    "http-file-root": "http/file-root.v1.schema.json",
    "http-file-entry": "http/file-entry.v1.schema.json",
    "http-file-version": "http/file-version.v1.schema.json",
    "http-file-share": "http/file-share.v1.schema.json",
  };
  const schemas = [];
  for (const [id, path] of Object.entries(expected)) {
    assert.deepEqual(catalog.contracts.find((value) => value.id === id), { id, family: "http", major: 1, role: "response", stability: "stable", path });
    const schema = await load(path);
    assert.deepEqual(schema["x-teamaibox-contract"], { family: "http", role: "response", major: 1 });
    schemas.push(schema);
  }
  const serialized = JSON.stringify(schemas);
  for (const forbidden of ["reference_id", "signed_url", "access_key", "secret_key", "blob_key", "storage_endpoint"]) assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  assert.match(serialized, /object_version/);
  assert.match(serialized, /retention_until/);
  assert.match(serialized, /quota_bytes/);
});
