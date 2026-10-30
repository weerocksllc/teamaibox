import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function webSource(relativePath) {
  return readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

test("administrator identity changes expose named focus-managed confirmations", async () => {
  const [users, roles, teams] = await Promise.all([
    webSource("users/UserAdministrationPanel.tsx"),
    webSource("roles/RoleAdministrationPanel.tsx"),
    webSource("teams/TeamAdministrationPanel.tsx"),
  ]);
  assert.match(users, /className="identity-confirmation" role="alertdialog" aria-labelledby="identity-confirmation-title"/);
  assert.match(users, /id="identity-confirmation-title"/);
  assert.match(users, /<input autoFocus type="password"/);
  assert.match(users, /<button autoFocus=\{pending\.kind !== "reset"\}/);
  assert.match(roles, /className="identity-confirmation" role="alertdialog" aria-labelledby="role-confirmation-title"/);
  assert.match(roles, /focusInlineConfirmation\(confirmation.current\)/);
  assert.match(roles, /event.key === "Escape" && !saving/);
  assert.match(teams, /className="identity-confirmation" role="alertdialog" aria-labelledby="team-confirmation-title"/);
  assert.match(teams, /focusInlineConfirmation\(confirmation.current\)/);
  assert.match(teams, /event.key === "Escape" && !saving/);
  for (const source of [users, roles, teams]) assert.doesNotMatch(source, /identity-confirmation"[^>]*aria-modal="true"/);
});

test("maintenance blockers, warnings, and manual recovery are announced", async () => {
  const source = await webSource("updates/MaintenancePanel.tsx");
  assert.match(source, /className="maintenance-findings" role=\{plan\.blockers\.length > 0 \? "alert" : "status"\}/);
  assert.match(source, /aria-live=\{plan\.blockers\.length > 0 \? "assertive" : "polite"\}/);
  assert.match(source, /className="maintenance-execute" role="note"/);
  assert.match(source, /className="maintenance-manual" role="alert"/);
});

test("destructive encryption transitions announce their warnings", async () => {
  const encryption = await webSource("encryption/EncryptionAdministrationPanel.tsx");
  assert.match(encryption, /<p role="alert">\{t\("encryption\.commit\.warning"\)\}<\/p>/);
});

test("one-time recovery codes announce their save warning", async () => {
  const source = await webSource("auth/AuthenticatedApp.tsx");
  assert.match(source, /className="setup-recovery__warning" role="alert"/);
});
