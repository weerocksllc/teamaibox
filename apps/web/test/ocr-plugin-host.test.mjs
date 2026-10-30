import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const workspace = await readFile(new URL("../src/applications/DynamicApplicationWorkspace.tsx", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../../ocr-plugin/manifest.release-template.json", import.meta.url), "utf8"));
const routes = JSON.parse(await readFile(new URL("../../../deploy/plugins/web-routes.v1.json", import.meta.url), "utf8"));

test("Text Recognition opens as an isolated official ApplicationPlugin", () => {
  assert.match(app, /<DynamicApplicationWorkspace/);
  assert.equal(manifest.id, "official.ocr");
  assert.match(workspace, /fact\.route\.pathPrefix/);
  assert.ok(workspace.includes('sandbox={`allow-downloads allow-forms allow-same-origin allow-scripts${fact.pluginKey === "official.virtual-computers" ? " allow-popups" : ""}`}'));
  assert.match(workspace, /event\.origin !== globalThis\.location\.origin/);
  assert.match(workspace, /new CustomEvent\("teamaibox:plugin-handoff"/);
  assert.match(app, /teamaibox:plugin-handoff/);
  assert.deepEqual(routes.routes.find((route) => route.pluginId === "official.ocr"), {
    pluginId: "official.ocr", pathPrefix: "/plugins/official.ocr", origin: "http://ocr-plugin:8080",
  });
});
