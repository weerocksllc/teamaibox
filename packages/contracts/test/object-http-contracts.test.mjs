import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const load = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("browser object contracts publish scoped references without storage credentials", async () => {
  const catalog = await load("catalog.v1.json");
  const expected = {
    "object-browser-upload-result": ["objects/browser-upload-result.v1.schema.json", "response"],
    "object-compute-reference-request": ["objects/compute-reference-request.v1.schema.json", "request"],
    "object-list": ["objects/object-list.v1.schema.json", "response"],
  };
  for (const [id, [path, role]] of Object.entries(expected)) {
    const entry = catalog.contracts.find((item) => item.id === id);
    assert.deepEqual(entry, { id, family: "object", major: 1, role, stability: "stable", path });
    assert.deepEqual((await load(path))["x-teamaibox-contract"], { family: "object", role, major: 1 });
  }
  const serialized = JSON.stringify(await Promise.all(Object.values(expected).map(([path]) => load(path))));
  for (const forbidden of ["token", "access_key", "secret_key", "endpoint_uri", "worker_id"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
  }
  const upload = await load(expected["object-browser-upload-result"][0]);
  assert.ok(upload.required.includes("reference_expires_at"));
});
