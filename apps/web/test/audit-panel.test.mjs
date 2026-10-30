import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/audit/AuditPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/audit/audit-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator audit panel reads signed events and verifies the full chain", () => {
  assert.match(client, /\/api\/v1\/admin\/audit\/events/);
  assert.match(client, /\/api\/v1\/admin\/audit\/verify/);
  assert.match(panel, /verifyAuditChain\(\)/);
  assert.match(client, /previousEventHash/);
  assert.match(client, /checkpoint/);
  assert.match(app, /selected\?\.id === "audit"/);
});

test("audit browser surface is read-only, domain-filtered, and never renders metadata content", () => {
  assert.match(panel, /domains\.map/);
  assert.match(panel, /loadAuditEvents\(\{ domain:/);
  assert.match(panel, /appliedCorrelation/);
  assert.match(client, /query\.set\("correlationId", correlationId\)/);
  assert.match(panel, /item\.correlationId/);
  assert.doesNotMatch(panel, /JSON\.stringify\(item\.metadata/);
  assert.doesNotMatch(client, /method:\s*"(?:POST|PATCH|DELETE)"/);
});

test("opening, filtering and refreshing audit records do not verify all history", () => {
  const reload = panel.slice(panel.indexOf('const reload ='), panel.indexOf('const verify ='));
  assert.match(reload, /await loadAuditEvents/);
  assert.doesNotMatch(reload, /verifyAuditChain|Promise\.all/);
  assert.equal(panel.match(/await verifyAuditChain\(\)/g)?.length, 1);
  assert.match(panel, /onClick=\{\(\) => void verify\(\)\}/);
  assert.match(panel, /audit-integrity--unchecked/);
});

test("audit event rows collapse to a two-column mobile layout", () => {
  assert.match(styles, /\.audit-event \{[^}]*grid-template-columns: auto minmax\(180px, 1\.3fr\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.audit-event \{ grid-template-columns: auto minmax\(0, 1fr\);/);
});
