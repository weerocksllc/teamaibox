import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createDrawingPluginServer } from "../src/server.mjs";

async function start() {
  const server = createDrawingPluginServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("serves health and the complete drawing application from its namespaced path", async () => {
  const fixture = await start();
  try {
    const health = await fetch(fixture.origin + "/health/ready");
    assert.deepEqual(await health.json(), { status: "ready", pluginId: "official.drawing", version: "0.1.0" });

    const page = await fetch(fixture.origin + "/plugins/official.drawing");
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /id="drawing-form"/);
    assert.match(html, /data-intent="automatic"/);
    assert.match(html, /data-intent="fast"/);
    assert.doesNotMatch(html, /advanced-intents|source-image|data-intent="(?:editing|high-quality|custom-lora)"/);
    assert.match(html, /id="model-tier"/);
    assert.match(html, /id="route-disclosure"/);
    assert.match(html, /id="capability-boundary"/);
    assert.match(html, /办公绘图模型在本机常驻/);
    assert.match(html, /\/plugins\/official\.drawing\/app\.js/);

    const script = await fetch(fixture.origin + "/plugins/official.drawing/app.js");
    const source = await script.text();
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(source, /\/v1\/images\/generations/);
    assert.match(source, /\/api\/v1\/jobs\/\$\{state\.jobId\}\/cancel/);
    assert.match(source, /if \(!TERMINAL\.has\(job\.status\)\) state\.pollTimer = setTimeout\(pollJob, 250\)/);
    assert.match(source, /teamaibox\.ai\.image-result\.v1/);
    assert.match(source, /output\.encrypted !== true/);
    assert.match(source, /sessionStorage\.setItem/);
    assert.match(source, /profileUnavailable/);
    assert.match(source, /protected_office_profile_unavailable: "本机办公绘图服务暂不可用/);
    assert.match(source, /protected_office_profile_unavailable: "The local Drawing service is unavailable/);
    assert.match(source, /parseDrawingIntentRouterV2/);
    assert.match(source, /preferredDrawingIntentV2/);
    assert.match(source, /applySizeConstraints\(selected\)/);
    assert.match(source, /selected\.modelAlias/);
    assert.match(source, /model_profile_id: selected\.selectedProfileId/);
    assert.match(source, /selectedProfileDisplayName/);
    assert.doesNotMatch(source, /mask-image|negative-prompt|uploadObject|advancedControls|images.edits/);

    const routerClient = await fetch(fixture.origin + "/plugins/official.drawing/intent-router-client-v2.mjs");
    const routerClientSource = await routerClient.text();
    assert.equal(routerClient.status, 200);
    assert.match(routerClientSource, /protected-resident/);
    assert.doesNotMatch(routerClientSource, /MAIN_PROFILE_ID|ADVANCED_PROFILE_IDENTITIES/);
    assert.match(routerClientSource, /preferredDrawingIntentV2/);
  } finally { await fixture.close(); }
});

test("is read-only and rejects paths outside the plugin asset root", async () => {
  const fixture = await start();
  try {
    const mutation = await fetch(fixture.origin + "/plugins/official.drawing", { method: "POST" });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get("allow"), "GET, HEAD");
    assert.equal((await mutation.json()).error.code, "method_not_allowed");

    const traversal = await fetch(fixture.origin + "/plugins/official.drawing/%00/package.json");
    assert.equal(traversal.status, 404);
    const unrelated = await fetch(fixture.origin + "/package.json");
    assert.equal(unrelated.status, 404);
  } finally { await fixture.close(); }
});

test("release manifest cannot be mistaken for a signed installable artifact", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.drawing");
  assert.equal(manifest.type, "ApplicationPlugin");
  assert.equal(manifest.entryPoints.web.integration, "iframe");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.deepEqual(manifest.themes.supported, ["light", "dark"]);
  assert.deepEqual(manifest.permissions.platformApiScopes, ["ai:invoke", "files:read", "files:write"]);
  assert.match(manifest.images[0].variants[0].reference, /^__RELEASE_PIPELINE_MUST_SET_/);
  assert.match(manifest.signature.value, /^__RELEASE_PIPELINE_MUST_SIGN_/);
});
