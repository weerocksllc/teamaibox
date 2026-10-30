import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sources = new Map(await Promise.all([
  ["device", "../src/device/AppliancePanel.tsx"],
  ["users", "../src/users/UserAdministrationPanel.tsx"],
  ["sources", "../src/sources/SourceCenterPanel.tsx"],
  ["providers", "../src/providers/ExternalProvidersPanel.tsx"],
  ["teams", "../src/teams/TeamAdministrationPanel.tsx"],
  ["roles", "../src/roles/RoleAdministrationPanel.tsx"],
  ["storage", "../src/storage/StorageAdministrationPanel.tsx"],
  ["encryption", "../src/encryption/EncryptionAdministrationPanel.tsx"],
  ["models", "../src/models/ModelAdministrationPanel.tsx"],
  ["plugins", "../src/plugins/PluginAdministrationPanel.tsx"],
  ["queues", "../src/queues/QueueAdministrationPanel.tsx"],
  ["audit", "../src/audit/AuditPanel.tsx"],
  ["updates", "../src/updates/MaintenancePanel.tsx"],
  ["assistant", "../src/assistant/AssistantWorkspace.tsx"],
].map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), "utf8")])));

test("initial loading surfaces announce busy status without exposing spinner graphics", () => {
  for (const [key, source] of sources) {
    assert.match(source, /role="status" aria-live="polite" aria-busy="true"/, `${key} loading status is not announced`);
    if (source.includes('className="auth-spinner"')) {
      assert.match(source, /className="auth-spinner"[^>]*aria-hidden="true"/, `${key} spinner is not hidden from assistive technology`);
    }
  }
});

test("catalog and task errors are alerts while their loading states remain polite", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /role=\{catalogState === "loading" \? "status" : "alert"\}/);
  assert.match(app, /aria-busy=\{catalogState === "loading" \? "true" : undefined\}/);
  assert.match(app, /request: \(signal: AbortSignal\) => loadApplicationCatalog\(\{ signal \}\)/);
  assert.match(app, /setCatalogRetryRevision\(\(revision\) => revision \+ 1\)/);
  assert.match(app, /t\("applications\.retry"\)/);
  assert.match(app, /role=\{state === "error" \? "alert" : "status"\}/);
  assert.match(app, /aria-busy=\{state === "loading" \? "true" : undefined\}/);
});

test("administration failure surfaces use assertive alert semantics", () => {
  for (const key of ["teams", "roles", "storage", "encryption", "models"]) {
    assert.match(sources.get(key), /role="alert"/, `${key} failure surface is not announced`);
  }
});

test("team and role mutation results are announced without relying on color", () => {
  for (const key of ["teams", "roles"]) {
    assert.match(sources.get(key), /__notice" role="status" aria-live="polite"/, `${key} success notice is not announced`);
    assert.match(sources.get(key), /__error" role="alert"/, `${key} mutation error is not announced`);
  }
});
