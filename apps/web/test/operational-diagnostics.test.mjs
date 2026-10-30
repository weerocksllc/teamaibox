import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/device/AppliancePanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/device/appliance-client.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator diagnostics expose health, alerts, correlation lookup, and safe export", () => {
  for (const path of ["operations/health", "operations/alerts", "operations/correlations/", "operations/diagnostic-exports", "operations/retention/run"]) assert.ok(client.includes(path));
  assert.match(panel, /loadOperationalDiagnostics\(\)/);
  assert.match(panel, /lookupOperationalCorrelation\(correlationId\.trim\(\)\)/);
  assert.match(panel, /exportOperationalDiagnostics\(\{/);
  assert.match(panel, /runOperationalRetention\(\)/);
  assert.doesNotMatch(panel, /\.sensitiveContent\b/);
});

test("state-changing diagnostic actions use CSRF and sensitive access is separately permission gated", () => {
  assert.match(client, /__Host-teamaibox-csrf=/);
  assert.match(client, /"x-csrf-token": csrfToken\(\)/);
  assert.match(panel, /permissions\.includes\("operations:manage"\)/);
  assert.match(panel, /permissions\.includes\("diagnostic_sensitive:view"\)/);
  assert.match(panel, /includeSensitive \? \{ includeSensitive: true, reason: reason\.trim\(\) \} : \{\}/);
  assert.match(panel, /reason\.trim\(\)\.length < 8/);
});

test("diagnostic panels retain closed responsive columns on mobile", () => {
  assert.match(styles, /\.diagnostics-health \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.diagnostics-health \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.diagnostics-correlation \{ grid-template-columns: minmax\(0, 1fr\) repeat\(2, auto\);/);
});

test("diagnostic lists expose all remaining rows instead of hiding records after 8 or 12", () => {
  assert.doesNotMatch(panel, /(?:health|alerts|lookup\.signals)\.slice\(0, (?:8|12)\)/);
  for (const state of ["healthShown", "alertsShown", "signalsShown", "overviewAlertsShown"]) assert.ok(panel.includes(state));
  assert.equal((panel.match(/t\("admin\.diagnostics\.more"\)/g) ?? []).length, 4);
});
