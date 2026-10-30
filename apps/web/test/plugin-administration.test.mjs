import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/plugins/PluginAdministrationPanel.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/plugins/plugin-administration-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator Plugins is a real verified import and lifecycle surface", () => {
  assert.match(app, /availableAdminDomains[^;]+"plugins"/s);
  assert.match(app, /selected\?\.id === "plugins" && <PluginAdministrationPanel/);
  assert.match(client, /\/api\/v1\/admin\/plugins\/imports/);
  for (const operation of ["install", "enable", "disable", "upgrade", "uninstall"]) assert.match(panel, new RegExp(`"${operation}"`));
  for (const source of ["marketplace", "private-registry", "offline-bundle"]) assert.match(panel, new RegExp(source));
  assert.match(panel, /bundlePayloadDigest/);
  assert.match(panel, /protectedOfficial/);
});

test("plugin administration uses CSRF, semantic themes, and closed responsive layouts", () => {
  assert.match(client, /__Host-teamaibox-csrf/);
  assert.match(client, /credentials: "same-origin"/);
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.match(styles, /\.plugin-admin \{[^}]+var\(--surface-raised\)/);
  assert.match(styles, /@media \(max-width: 720px\)[^}]+\.plugin-admin/s);
  assert.match(styles, /\.plugin-admin[^}]+var\(--text-muted\)/s);
  assert.doesNotMatch(styles, /\.plugin-admin[^}]+#[0-9a-fA-F]{3,8}/s);
});
