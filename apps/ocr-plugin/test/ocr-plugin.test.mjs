import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createOcrPluginServer } from "../src/server.mjs";

async function fixture() {
  const server = createOcrPluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves a namespaced OCR application with upload, drive, correction, export, and handoff", async () => {
  const app = await fixture();
  try {
    const health = await fetch(app.origin + "/health/ready");
    assert.deepEqual(await health.json(), { status: "ready", pluginId: "official.ocr", version: "0.1.0" });
    const html = await (await fetch(app.origin + "/plugins/official.ocr")).text();
    assert.match(html, /id="file" type="file"/);
    assert.match(html, /data-source="drive"/);
    assert.match(html, /id="corrected-text"[^>]+data-i18n-aria="correctedText"[^>]+aria-label="识别校正文稿"/);
    assert.match(html, /id="handoff"/);
    assert.match(html, /id="model-tier"/);
    assert.match(html, /id="geometry-note"/);
    const source = await (await fetch(app.origin + "/plugins/official.ocr/app.js")).text();
    assert.match(source, /uploadObject/);
    assert.match(source, /capability:\s*['"]ocr['"]/);
    assert.match(source, /\/api\/v1\/ai\/ocr/);
    assert.match(source, /\/api\/v1\/jobs\/\$\{state\.jobId\}\/cancel/);
    assert.match(source, /teamaibox\.ai\.ocr-result\.v1/);
    assert.match(source, /teamaibox\.plugin-handoff\/v1/);
    assert.match(source, /body:\{capability:"translation"\}/);
    assert.match(source, /object\.objectId/);
    assert.match(source, /profileUnavailable/);
    assert.match(source, /sessionStorage\.setItem\(JOB_STORAGE_KEY,state\.jobId\)/);
    assert.match(source, /\/api\/v1\/applications/);
    assert.match(source, /catalog\.applications/);
    assert.match(source, /item=>item\.pluginKey===PLUGIN_ID/);
    assert.match(source, /geometry_supported!==false/);
    assert.match(source, /textBlocksView/);
    assert.match(source, /HunyuanOCR DFlash/);
    assert.match(source, /Markdown tables and LaTeX formulas/);
    assert.match(source, /JSON \+ text blocks/);
    assert.match(source, /messages\["zh-CN"\]\.correctedText="识别校正文稿"/);
    assert.match(source, /messages\.en\.correctedText="Corrected recognition text"/);
  } finally { await app.close(); }
});

test("static OCR container exposes no mutation or unrelated filesystem path", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(app.origin + "/plugins/official.ocr", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.origin + "/plugins/official.ocr/%00/package.json")).status, 404);
    assert.equal((await fetch(app.origin + "/package.json")).status, 404);
  } finally { await app.close(); }
});

test("release template requires real OCI evidence and official signing", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.ocr");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.ok(manifest.compatibility.requiredCapabilities.includes("encrypted-objects"));
  assert.ok(manifest.compatibility.requiredCapabilities.includes("object-references"));
  assert.ok(manifest.permissions.platformApiScopes.includes("files:read"));
  assert.ok(manifest.permissions.platformApiScopes.includes("files:write"));
  assert.ok(!manifest.permissions.platformApiScopes.includes("file:read"));
  assert.ok(!manifest.permissions.platformApiScopes.includes("file:write"));
  assert.match(manifest.images[0].variants[0].reference, /^__RELEASE_PIPELINE_MUST_SET_/);
  assert.match(manifest.signature.value, /^__RELEASE_PIPELINE_MUST_SIGN_/);
});
