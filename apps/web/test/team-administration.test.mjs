import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const panel = await readFile(new URL("../src/teams/TeamAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/teams/team-administration-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator Team domain performs confirmed persistent membership changes", () => {
  assert.match(app, /availableAdminDomains = new Set\(\[.*"team"/s);
  assert.match(app, /selected\?\.id === "team".*TeamAdministrationPanel/s);
  assert.match(client, /GET|fetch\("\/api\/v1\/admin\/teams"/);
  assert.match(client, /\/members/);
  assert.match(client, /x-csrf-token/);
  assert.match(panel, /identity-confirmation/);
  assert.match(panel, /setTeamMembership/);
  assert.match(panel, /data-team-identity/);
  assert.match(panel, /action: "update"/);
});

test("Team administration is responsive and uses semantic themes", () => {
  assert.match(css, /\.team-admin/);
  assert.match(css, /var\(--surface-raised\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.team-admin__layout/);
  assert.doesNotMatch(panel, /#[0-9a-f]{3,8}/i);
});
