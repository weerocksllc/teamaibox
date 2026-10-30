import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("administrator domains are loaded only when selected", () => {
  const panels = [
    "AdminOverviewPanel",
    "UserAdministrationPanel", "RoleAdministrationPanel", "TeamAdministrationPanel",
    "ModelAdministrationPanel", "QueueAdministrationPanel", "AppliancePanel",
    "ExternalProvidersPanel", "PluginAdministrationPanel", "StorageAdministrationPanel",
    "EncryptionAdministrationPanel", "SourceCenterPanel", "AuditPanel",
    "MaintenancePanel",
    "PhoneAdministrationPanel",
  ];
  for (const panel of panels) {
    assert.match(app, new RegExp(`const ${panel} = lazy\\(\\(\\) => import\\(`), `${panel} is still part of the initial bundle`);
  }
  assert.doesNotMatch(app, /import \{ (?:User|Role|Team|Model|Queue|Managed|External|Plugin|Storage|Encryption|Source|Audit|Backup|Maintenance)AdministrationPanel/);
});

test("administrator lazy loading has an announced busy fallback", () => {
  assert.match(app, /<Suspense fallback=\{<div className="admin-panel-loading" role="status" aria-live="polite" aria-busy="true">/);
  assert.match(app, /t\("admin\.loading"\)/);
});
