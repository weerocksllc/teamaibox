import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const panel = await readFile(new URL("../src/roles/RoleAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/roles/role-administration-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator Roles domain is a real persistent grant and revoke surface", () => {
  assert.match(app, /availableAdminDomains = new Set\(\["overview", "users", "roles"/);
  assert.match(app, /selected\?\.id === "roles" && <RoleAdministrationPanel/);
  assert.match(client, /GET|fetch\("\/api\/v1\/admin\/roles"/);
  assert.match(client, /\/api\/v1\/admin\/roles\/\$\{encodeURIComponent\(input\.roleKey\)\}\/grants/);
  assert.match(client, /__Host-teamaibox-csrf/);
  assert.match(panel, /setIdentityRole/);
  assert.match(panel, /identity-confirmation/);
  assert.doesNotMatch(panel, /mock|fixture|coming soon/i);
});

test("role inventory is fixed, permission-visible, responsive, and uses semantic themes", () => {
  assert.match(panel, /roleOrder = \["owner", "system_admin"/);
  assert.match(panel, /role\.permissions\.map/);
  assert.match(styles, /\.role-admin__cards/);
  assert.match(styles, /var\(--surface-raised\)/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.role-admin__cards \{ grid-template-columns: 1fr; \}/);
});
