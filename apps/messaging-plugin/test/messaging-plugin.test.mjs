import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createMessagingPluginServer } from "../src/server.mjs";
import { validatePluginManifest } from "../../../services/plugin-runtime/src/manifest-validator.mjs";

async function fixture() {
  const server = createMessagingPluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves a responsive namespaced messaging application", async () => {
  const app = await fixture();
  try {
    const health = await fetch(app.origin + "/health/ready");
    assert.deepEqual(await health.json(), { status: "ready", pluginId: "official.messaging", version: "0.1.0" });
    const html = await (await fetch(app.origin + "/plugins/official.messaging")).text();
    assert.match(html, /class="conversation-pane"/);
    assert.match(html, /id="message-list"/);
    assert.match(html, /id="details-pane"/);
    assert.match(html, /id="attachment-input"/);
    assert.match(html, /id="open-notifications"/);
    assert.match(html, /id="message-search-results"/);
    assert.match(html, /id="message-search-more"/);
    assert.match(html, /id="notification-more"/);
    const paging = await fetch(app.origin + '/plugins/official.messaging/result-pages.mjs');
    assert.equal(paging.status,200);assert.match(await paging.text(),/export class ResultPages/);
    const css = await (await fetch(app.origin + "/plugins/official.messaging/app.css")).text();
    assert.match(css, /\[hidden\]\{display:none!important\}/);
    assert.match(css, /@media\(max-width:760px\)/);
    assert.match(css, /data-mobile-view="chat"/);
  } finally { await app.close(); }
});

test("uses durable messaging cursors and protected object references without fake production conversations", async () => {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/v1\/messaging\/conversations\?limit=200/);
  assert.match(source, /\/api\/v1\/messaging\/events\?after=\$\{state\.cursor\}/);
  assert.match(source, /idempotency-key/);
  assert.match(source, /attachment_reference_ids/);
  assert.match(source, /uploadObject/);
  assert.match(source, /capability:\s*['"]messaging\.attachment['"]/);
  assert.match(source, /\/api\/v1\/messaging\/presence/);
  assert.match(source, /\/api\/v1\/messaging\/search\?q=/);
  assert.match(source, /\/api\/v1\/messaging\/notifications\?unread_only=1/);
  assert.match(source, /\/api\/v1\/messaging\/notifications\/\$\{item\.id\}\/read/);
  assert.match(source, /\/api\/v1\/identities\/directory\?limit=50/);
  assert.match(source, /function renderPeopleResults\(people\)/);
  assert.match(source, /renderPeopleResults\(state\.contacts\)/);
  assert.match(source, /attachments\/\$\{ordinal\}\/download/);
  assert.match(source, /\/api\/v1\/objects\/references\/\$\{reference\}\/content/);
  assert.match(source, /visibilitychange/);
  assert.doesNotMatch(source, /mockConversation|demoMessages|sampleMessages/);
});

test("keeps one conversation list and moves contacts into the new-conversation dialog", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /class="contact-panel"/);
  assert.match(html, /id="new-dialog"/);
  assert.match(html, /id="people-results"[^>]+role="listbox"/);
  assert.match(source, /renderPeopleResults\(state\.contacts\)/);
  assert.doesNotMatch(source, /function renderContacts\(\)/);
  assert.doesNotMatch(source, /function openDirectContact\(/);
});

test("static messaging container rejects mutation and filesystem escape", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(app.origin + "/plugins/official.messaging", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.origin + "/plugins/official.messaging/%00/package.json")).status, 404);
    assert.equal((await fetch(app.origin + "/package.json")).status, 404);
  } finally { await app.close(); }
});

test("release template declares delegated collaboration APIs and signed ARM64 evidence", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.messaging");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.deepEqual(manifest.themes.supported, ["light", "dark"]);
  assert.deepEqual(manifest.apis.map((value) => value.name), ["platform.messaging", "platform.objects"]);
  assert.equal(manifest.permissions.network.mode, "none");
  assert.match(manifest.images[0].variants[0].reference, /^__RELEASE_PIPELINE_MUST_SET_/);
  assert.match(manifest.signature.value, /^__RELEASE_PIPELINE_MUST_SIGN_/);

  const releaseShape = structuredClone(manifest);
  releaseShape.images[0].variants[0].reference = "registry.teamaibox.local/official/messaging:0.1.0";
  releaseShape.images[0].variants[0].digest = `sha256:${"a".repeat(64)}`;
  releaseShape.signature.keyId = "teamaibox.official/release-2026";
  releaseShape.signature.payloadDigest = `sha256:${"b".repeat(64)}`;
  releaseShape.signature.value = Buffer.alloc(64).toString("base64");
  assert.equal(validatePluginManifest(releaseShape, { verifyPayloadDigest: false }).pluginId, "official.messaging");
});

test("browser validation evidence covers desktop, mobile, both locales, and both themes", async () => {
  const evidence = JSON.parse(await readFile(new URL("../../../architecture/validation/messaging-browser-validation.v1.json", import.meta.url), "utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.nativeMobileClientRequired, false);
  assert.equal(evidence.productionFixtureData, false);
  assert.ok(evidence.viewports.some((value) => value.width >= 1280 && value.locale === "zh-CN" && value.theme === "dark"));
  assert.ok(evidence.viewports.some((value) => value.width <= 390 && value.locale === "zh-CN" && value.theme === "dark"));
  assert.ok(evidence.viewports.some((value) => value.locale === "en" && value.theme === "light"));
  assert.ok(evidence.defectsFoundAndClosed.some((value) => value.id === "messaging-hidden-state-css-priority"));
});

test("search, composer, and the empty details state have accessible names", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="conversation-search"[^>]+data-i18n-aria="search"[^>]+aria-label="搜索会话与消息"/);
  assert.match(html, /id="message-input"[^>]+data-i18n-aria="messagePlaceholder"[^>]+aria-label="发送消息"/);
  assert.match(html, /id="details-title">选择一个会话<\/h3>/);
  assert.match(html, /id="details-kind">选择会话后可查看成员与安全信息。<\/p>/);
  assert.match(source, /detailsEmptyTitle:"Select a conversation"/);
  assert.match(source, /if\(state\.activeId\)renderActive\(\);else/);
});
