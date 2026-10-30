import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspace = await readFile(new URL("../src/applications/DynamicApplicationWorkspace.tsx", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../../drawing-plugin/manifest.release-template.json", import.meta.url), "utf8"));
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const routes = JSON.parse(await readFile(new URL("../../../deploy/plugins/web-routes.v1.json", import.meta.url), "utf8"));

test("drawing catalog item opens the isolated official plugin workspace", () => {
  assert.match(app, /<DynamicApplicationWorkspace/);
  assert.equal(manifest.id, "official.drawing");
  assert.match(workspace, /src=\{source\}/);
  assert.ok(workspace.includes('sandbox={`allow-downloads allow-forms allow-same-origin allow-scripts${fact.pluginKey === "official.virtual-computers" ? " allow-popups" : ""}`}'));
  assert.match(workspace, /createPluginPreferenceSnapshotV1/);
  assert.match(workspace, /event\.origin !== globalThis\.location\.origin/);
  assert.match(workspace, /event\.data\?\.pluginId === fact\.pluginKey/);
});

test("drawing workspace is full-screen, responsive, and has one exact container route", () => {
  assert.match(styles, /\.plugin-workspace\s*\{[\s\S]*position: fixed;[\s\S]*height: 100dvh;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.plugin-workspace/);
  assert.deepEqual(routes.routes.find((route) => route.pluginId === "official.drawing"), {
    pluginId: "official.drawing",
    pathPrefix: "/plugins/official.drawing",
    origin: "http://drawing-plugin:8080",
  });
});
