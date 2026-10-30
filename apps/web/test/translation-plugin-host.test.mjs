import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const host = await readFile(new URL("../src/applications/DynamicApplicationWorkspace.tsx", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../../translation-plugin/manifest.release-template.json", import.meta.url), "utf8"));
const routes = JSON.parse(await readFile(new URL("../../../deploy/plugins/web-routes.v1.json", import.meta.url), "utf8"));
test("Translation opens in an isolated host and relays scoped cross-app handoffs", () => {
  assert.equal(manifest.id, "official.translation"); assert.match(app, /teamaibox:plugin-handoff/);
  assert.match(app, /<DynamicApplicationWorkspace key=\{activeApp\.pluginKey\}/);
  assert.match(host, /event\.origin !== globalThis\.location\.origin/); assert.match(host, /handoff/);
  assert.ok(host.includes('sandbox={`allow-downloads allow-forms allow-same-origin allow-scripts${fact.pluginKey === "official.virtual-computers" ? " allow-popups" : ""}`}'));
  assert.match(host, /new CustomEvent\("teamaibox:plugin-handoff"/);
  assert.deepEqual(routes.routes.find((route) => route.pluginId === "official.translation"), { pluginId: "official.translation", pathPrefix: "/plugins/official.translation", origin: "http://translation-plugin:8080" });
});
