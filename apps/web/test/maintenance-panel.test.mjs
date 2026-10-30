import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/updates/MaintenancePanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/updates/maintenance-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");

test("maintenance panel separates preflight planning from exact confirmed execution", () => {
  assert.match(client, /\/api\/v1\/admin\/updates\/plans/); assert.match(client, /x-csrf-token/); assert.match(client, /maintenance:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(panel, /prepareMaintenancePlan/); assert.match(panel, /executeMaintenancePlan/); assert.match(panel, /APPLY \$\{plan\.planId\}/); assert.match(panel, /confirmation !== exact/);
  assert.match(app, /selected\?\.id === "updates"/); assert.match(app, /MaintenancePanel canManage=\{canManage\}/);
});

test("maintenance UI exposes Secure Boot runtime model and device evidence without execution material", () => {
  for (const fact of ["secureBootCompatible", "runtimeCompatible", "requiresRevalidationProfileIds", "rollbackInstructions", "recoveryInstructions"]) assert.match(panel, new RegExp(fact));
  assert.doesNotMatch(client, /imageManifest|packagePlan|hostCommand|executionDescriptor|privateEndpoint|accessToken|clientSecret/i);
  assert.match(styles, /\.maintenance-evidence-grid/); assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.maintenance-workspace/);
});

test("maintenance candidate, finding, and recovery facts switch with the active locale", () => {
  for (const helper of ["candidateName", "instruction", "finding"]) assert.match(panel, new RegExp(`${helper}\\(`));
  for (const key of ["maintenance.candidate.platform_2026_08_22_failure", "maintenance.finding.managed_workloads_require_drain",
    "maintenance.node.lifecycle.ready", "maintenance.node.health.healthy", "maintenance.instruction.reject_unhealthy_candidate",
    "maintenance.instruction.use_durable_previous_digest"]) {
    assert.equal((i18n.match(new RegExp(`\\"${key.replaceAll(".", "\\.")}\\"`, "g")) ?? []).length, 2, `${key} must exist in both locales`);
  }
});
