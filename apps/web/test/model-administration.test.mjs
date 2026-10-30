import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/models/ModelAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/models/model-admin-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const sourceClient = await readFile(new URL("../src/sources/source-center-client.ts", import.meta.url), "utf8");
const sourcePanel = await readFile(new URL("../src/sources/SourceCenterPanel.tsx", import.meta.url), "utf8");

test("model administration renders lifecycle, compatibility, comparison, limitation, and raw evidence surfaces", () => {
  for (const key of ["compatibilityMatrix", "validationRuns", "comparisons", "knownLimitations", "rawRunLinks", "routingRecommendation"]) {
    assert.match(panel, new RegExp(`card\\.${key}`));
  }
  assert.match(panel, /model-lifecycle-badge--\$\{card\.lifecycle\.state\}/);
  assert.match(client, /\/api\/v1\/admin\/model-profiles\?limit=200/);
  assert.match(client, /\/api\/v1\/admin\/model-profiles\/by-key/);
  assert.match(app, /selected\?\.id === "models" && <ModelAdministrationPanel/);
});

test("model administration exposes truthful runtime facts and validation-only experimental routing", () => {
  assert.match(client, /\/api\/v1\/admin\/appliance/);
  assert.match(client, /model-routing-policies\/\$\{encodeURIComponent\(policyKey\)\}\/experimental-profiles\?environment=validation/);
  assert.match(client, /environment: "validation"/);
  assert.doesNotMatch(client, /environment: "production"/);
  assert.match(client, /"x-csrf-token": csrfToken\(\)/);
  assert.match(panel, /data-model-runtime-state=/);
  assert.match(panel, /data-model-validation-route=/);
  assert.match(panel, /admin\.models\.runtime_not_loaded/);
  assert.match(panel, /admin\.models\.production_locked/);
  assert.match(app, /ModelAdministrationPanel locale=\{locale\} canManage=\{canManage\}/);
});

test("model administration has dedicated tablet and mobile layouts", () => {
  assert.match(styles, /\.model-admin-workspace \{[^}]*grid-template-columns:/);
  const mobile = styles.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(mobile, /\.model-admin-workspace \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(mobile, /\.model-card-metrics \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(mobile, /\.model-runtime-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(mobile, /\.model-compatibility-table > div \{ grid-template-columns: 70px minmax\(0, 1fr\);/);
  assert.match(mobile, /\.model-compatibility-table code \{ grid-column: 2; white-space: normal; overflow-wrap: anywhere;/);
});

test("Source Center loads live data-plane counters and renders unavailable facts without fabrication", () => {
  assert.match(sourceClient, /source-center\/data-planes/);
  assert.match(sourcePanel, /source-data-planes/);
  assert.match(sourcePanel, /facts\.requests \?\? "—"/);
  assert.match(sourcePanel, /facts\.cacheHits \?\? "—"/);
});
