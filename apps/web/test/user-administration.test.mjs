import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const panel = await readFile(new URL("../src/users/UserAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/users/identity-administration-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator Users domain exposes real persistent operations and confirmations", () => {
  assert.match(app, /selected\?\.id === "users" && <UserAdministrationPanel/);
  assert.match(panel, /createLocalMember/);
  assert.match(panel, /setManagedIdentityStatus/);
  assert.match(panel, /resetManagedIdentityPassword/);
  assert.match(panel, /ActionConfirmation/);
  assert.match(panel, /identity_self_disable_forbidden/);
  assert.match(client, /\/api\/v1\/admin\/users/);
  assert.match(client, /__Host-teamaibox-csrf/);
  assert.doesNotMatch(panel, /mock|fixture|coming soon/i);
});

test("unimplemented administrator domains are explicitly disabled instead of presenting inert enabled controls", () => {
  assert.match(app, /const availableAdminDomains = new Set/);
  assert.match(app, /disabled=\{!item\.available\}/);
  assert.match(app, /admin\.not_available/);
  assert.doesNotMatch(app, /canManage && <button type="button" className="primary-button">\{t\("admin\.open"\)/);
});

test("a direct administrator URL fails closed without misrepresenting an ordinary member as appliance owner", () => {
  assert.match(app, /adminItems\.length > 0 \? \(/);
  assert.match(app, /<AdminAccessDenied/);
  assert.match(app, /primaryRoleLabelKey\(accountRoles\)/);
  assert.match(app, /roleLabelKey=\{accountRoleLabelKey\}/);
  assert.match(app, /admin\.denied\.title/);
  assert.doesNotMatch(app, /admin-scope-badge[^\n]+t\("profile\.role"\)/);
});

test("user administration remains responsive and themed through semantic tokens", () => {
  assert.match(styles, /\.identity-admin \{/);
  assert.match(styles, /var\(--surface-raised\)/);
  assert.match(styles, /\.identity-admin__table-wrap/);
  assert.match(styles, /overflow-x: auto/);
});

test("account pages use server totals, search all accounts and ignore stale requests", () => {
  assert.match(client, /URLSearchParams\(\{ limit: "50", offset: String\(offset\), q: query \}\)/);
  assert.match(panel, /page\?\.summary\.total/);
  assert.match(panel, /page\?\.summary\.owners/);
  assert.doesNotMatch(panel, /identities\.filter/);
  assert.match(panel, /sequence !== requestSequence\.current/);
  assert.match(panel, /disabled=\{busy \|\| !page\.hasMore\}/);
  assert.match(panel, /load\(page\.offset \+ page\.limit\)/);
  assert.match(panel, /load\(0, search\.trim\(\)\)/);
  assert.match(panel, /role="status".*admin\.users\.range/);
  assert.match(panel, /createButton\.current\?\.focus\(\)/);
  assert.match(panel, /event\.key === "Escape" && !busy/);
});
