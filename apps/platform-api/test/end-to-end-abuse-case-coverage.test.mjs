import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../../", import.meta.url);
const catalogUrl = new URL("docs/security/end-to-end-abuse-cases.v1.json", repositoryRoot);
const modelUrl = new URL("docs/security/end-to-end-threat-model.md", repositoryRoot);
const requiredDomains = new Set([
  "local_accounts",
  "browser_sessions",
  "plugins",
  "agent_code_execution",
  "external_providers",
  "object_grants",
  "software_sources",
  "local_appliance",
  "usb_removal",
  "physical_media",
]);
const exactCaseFields = new Set(["id", "domain", "threat", "control", "recovery", "testFile", "testName"]);

test("end-to-end threat model maps every required abuse domain and recovery to exact executable evidence", async () => {
  const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
  const model = await readFile(modelUrl, "utf8");
  assert.deepEqual(Object.keys(catalog).sort(), ["cases", "model", "schemaVersion"]);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.model, "team-ai-box-end-to-end-threat-model-v1");
  assert.ok(Array.isArray(catalog.cases));
  assert.ok(catalog.cases.length >= requiredDomains.size * 2);
  assert.deepEqual(new Set(catalog.cases.map(({ domain }) => domain)), requiredDomains);
  assert.equal(new Set(catalog.cases.map(({ id }) => id)).size, catalog.cases.length);

  const domainCounts = new Map();
  for (const abuseCase of catalog.cases) {
    assert.deepEqual(new Set(Object.keys(abuseCase)), exactCaseFields, `${abuseCase.id ?? "unknown"} fields drifted`);
    assert.match(abuseCase.id, /^ABUSE-[A-Z]+-[0-9]{3}$/);
    assert.ok(requiredDomains.has(abuseCase.domain));
    domainCounts.set(abuseCase.domain, (domainCounts.get(abuseCase.domain) ?? 0) + 1);
    for (const field of ["threat", "control", "recovery"]) {
      assert.equal(typeof abuseCase[field], "string");
      assert.ok(abuseCase[field].length >= 32 && abuseCase[field].length <= 512, `${abuseCase.id}.${field} is not bounded`);
    }
    assert.match(abuseCase.testFile, /^(?:apps|services|packages)\/[a-z0-9-]+\/test\/[a-z0-9-]+\.test\.mjs$/);
    assert.equal(typeof abuseCase.testName, "string");
    assert.ok(abuseCase.testName.length >= 16 && abuseCase.testName.length <= 180);
    const testSource = await readFile(new URL(abuseCase.testFile, repositoryRoot), "utf8");
    assert.ok(testSource.includes(`test(${JSON.stringify(abuseCase.testName)}`), `${abuseCase.id} does not reference an exact executable test`);
    assert.ok(model.includes(abuseCase.id), `${abuseCase.id} is absent from the threat model`);
  }
  for (const domain of requiredDomains) assert.ok(domainCounts.get(domain) >= 2, `${domain} lacks defense and recovery coverage`);
});

test("threat model declares boundaries, chained attacks, residual risks, and release-blocking semantics", async () => {
  const source = await readFile(modelUrl, "utf8");
  for (const heading of [
    "## Security objectives",
    "## Assets and actors",
    "## Trust boundaries and data flow",
    "## Domain abuse cases and recovery",
    "## Cross-boundary attack chains",
    "## Detection, containment, and evidence",
    "## Assumptions and residual risks",
    "## Release gate",
  ]) assert.ok(source.includes(heading), `threat model is missing ${heading}`);
  assert.match(source, /fail(?:ing)? closed|fail-safe/i);
  assert.match(source, /manual intervention|reconcil/i);
  assert.match(source, /blocks? the gate|blocks? the release/i);
});
