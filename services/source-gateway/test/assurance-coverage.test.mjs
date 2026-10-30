import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REQUIRED = new Set(["online-proxy", "cache-hit", "fully-offline-success", "missing-dependency", "pip-source-priority", "npm-source-priority", "apt-source-priority", "pin-deny", "credential-redaction", "corrupted-artifact", "x86-only-artifact", "offline-disk-removal"]);
const catalog = JSON.parse(await readFile(new URL("./assurance-scenarios.v1.json", import.meta.url), "utf8"));

test("software source assurance matrix maps every required scenario to an executable exact test", async () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(new Set(catalog.scenarios.map((item) => item.key)), REQUIRED);
  assert.equal(new Set(catalog.scenarios.map((item) => item.key)).size, catalog.scenarios.length);
  for (const scenario of catalog.scenarios) {
    assert.match(scenario.testFile, /^[a-z0-9-]+\.test\.mjs$/);
    const source = await readFile(new URL(`./${scenario.testFile}`, import.meta.url), "utf8");
    assert.ok(source.includes(`test("${scenario.testName}"`), `${scenario.key} does not map to the declared test`);
  }
});
