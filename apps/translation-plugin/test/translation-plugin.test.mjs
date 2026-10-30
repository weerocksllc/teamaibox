import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createTranslationPluginServer } from "../src/server.mjs";

async function fixture() {
  const server = createTranslationPluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves separate text, file, and drive translation with composed workflow provenance", async () => {
  const app = await fixture();
  try {
    assert.deepEqual(await (await fetch(app.origin + "/health/ready")).json(), { status: "ready", pluginId: "official.translation", version: "0.1.0" });
    const html = await (await fetch(app.origin + "/plugins/official.translation")).text();
    assert.match(html, /data-source="text"/); assert.match(html, /data-source="upload"/); assert.match(html, /data-source="drive"/);
    assert.match(html, /accept="image\/\*,application\/pdf,audio\/\*,video\/\*"/);
    assert.match(html, /id="model-tier"/);
    assert.match(html, /data-stage="ocr"/); assert.match(html, /data-stage="asr"/); assert.match(html, /data-stage="subtitle"/);
    assert.match(html, /id="workflow-stages"/); assert.match(html, /id="intermediates"/);
    assert.match(html, /id="source-text"[^>]+data-i18n-aria="sourceText"[^>]+aria-label="待翻译文字"/);
    assert.match(html, /id="translated-text"[^>]+data-i18n-aria="translatedText"[^>]+aria-label="翻译结果"/);
    const source = await (await fetch(app.origin + "/plugins/official.translation/app.js")).text();
    assert.match(source, /uploadObject/);
    assert.match(source, /capability:\s*['"]translation['"]/);
    assert.match(source, /\/api\/v1\/ai\/translations/);
    assert.match(source, /input_representation/);
    assert.match(source, /job\.progress\?\.value/);
    assert.match(source, /terminal\?1:reported/);
    assert.match(source, /terminal\?t\(status\)/);
    assert.doesNotMatch(source, /job\.progress\?\.message_key/);
    assert.match(source, /\/api\/v1\/jobs\/\$\{state\.jobId\}\/cancel/);
    assert.match(source, /if\(!TERMINAL\.has\(job\.status\)\)await poll\(\)/);
    assert.match(source, /teamaibox\.ai\.translation-result\.v1/);
    assert.match(source, /\/api\/v1\/objects\/references\/\$\{item\.reference_id\}\/content\?download=1/);
    assert.doesNotMatch(source, /targetPluginId:item\.kind/);
    assert.match(source, /local\/translation-default/);
    assert.match(source, /\/api\/v1\/applications/);
    assert.match(source, /sessionStorage\.setItem\(JOB_STORAGE_KEY,state\.jobId\)/);
    assert.match(source, /if\(state\.jobId\)void poll\(\)/);
    assert.match(source, /type\.startsWith\("video\/"\)\)return"video"/);
    assert.match(source, /subtitleStamp\(x\.start_ms,format\)/);
    assert.doesNotMatch(source, /video translation is not deployed/);
  } finally { await app.close(); }
});

test("static Translation container is read-only and namespaced", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(app.origin + "/plugins/official.translation", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.origin + "/plugins/official.translation/%00/package.json")).status, 404);
    assert.equal((await fetch(app.origin + "/package.json")).status, 404);
  } finally { await app.close(); }
});

test("release template requires real images and signature", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.translation");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.deepEqual(manifest.compatibility.requiredCapabilities, ["translation", "encrypted-objects", "object-references", "durable-jobs"]);
  assert.ok(manifest.permissions.platformApiScopes.includes("files:read"));
  assert.ok(manifest.permissions.platformApiScopes.includes("files:write"));
  assert.ok(manifest.compatibility.requiredCapabilities.includes("encrypted-objects"));
  assert.ok(manifest.compatibility.requiredCapabilities.includes("object-references"));
  assert.match(manifest.images[0].variants[0].reference, /^__RELEASE_PIPELINE_MUST_SET_/);
  assert.match(manifest.signature.value, /^__RELEASE_PIPELINE_MUST_SIGN_/);
});
