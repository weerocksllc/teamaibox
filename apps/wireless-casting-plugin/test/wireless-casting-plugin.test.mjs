import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { validatePluginManifest } from "../../../services/plugin-runtime/src/manifest-validator.mjs";
import { createWirelessCastingPluginServer } from "../src/server.mjs";

async function fixture() {
  const server = createWirelessCastingPluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves the complete localized casting workbench from a bounded static surface", async () => {
  const app = await fixture();
  try {
    assert.deepEqual(await (await fetch(app.origin + "/health/ready")).json(), {
status: "ready", pluginId: "official.wireless-casting", version: "0.1.9",
    });
    const page = await fetch(app.origin + "/plugins/official.wireless-casting");
    const html = await page.text();
    assert.equal(page.status, 200);
    for (const id of ["selected-users-control", "selected-team-control",
      "receiver-name", "receiver-pin", "join", "leave", "viewer-list", "force-stop", "output-health-list",
      "availability-card", "availability-gates", "availability-outputs", "casting-workspace"]) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /<video id="browser-video" controls playsinline muted hidden><\/video>/);
    assert.doesNotMatch(html, /\bautoplay\b/i);
    assert.match(html, /data-i18n="limitNoRecording"/);
    const css = await (await fetch(app.origin + "/plugins/official.wireless-casting/app.css")).text();
    assert.match(css, /data-theme="light"/);
    assert.match(css, /\[hidden\]\{display:none!important\}/);
    // Contain only works when the video box itself is bounded. Grid's
    // intrinsic minimum otherwise stretches portrait video past the frame.
    assert.match(css, /\.video-frame\{[^}]*position:relative/);
    assert.match(css, /\.video-frame video\{position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain\}/);
    assert.match(css, /@media\(max-width:680px\)/);
    assert.equal((await fetch(app.origin + "/plugins/official.wireless-casting", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.origin + "/plugins/official.wireless-casting/%00/package.json")).status, 404);
  } finally { await app.close(); }
});

test("client keeps invitations non-autoplay and enforces the manager-only boundary", async () => {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const mediaSource = await readFile(new URL("../src/public/casting-media-client-v1.mjs", import.meta.url), "utf8");
  const acceptOnly = source.slice(source.indexOf("async function acceptInvitationOnly"), source.indexOf("async function declineInvitation"));
  assert.match(acceptOnly, /api\.accept\(invitationId\)/);
  assert.doesNotMatch(acceptOnly, /api\.join|browser-video|play\(/);
  assert.match(source, /session\.perspective === "manager"/);
  assert.match(source, /session\.perspective !== "manager"/);
  assert.match(source, /manager-boundary/);
  assert.match(source, /const manager = session\.perspective === "manager"/);
  assert.match(source, /\$\("#manager-viewer-count"\)\.textContent/);
  assert.match(source, /mediaCredential = grant\.mediaCredential/);
  assert.match(source, /api\.mediaConnection\(session\.id, grant\.mediaCredential, browserInstanceId\)/);
  assert.match(source, /await mediaClient\.connect/);
  assert.match(mediaSource, /reconnectPolicy: Object\.freeze\(\{ nextRetryDelayInMs: \(\) => null \}\)/);
  assert.match(mediaSource, /livekit-client-2\.21\.0\.esm\.mjs/);
  assert.doesNotMatch(mediaSource, /localStorage|sessionStorage|MediaRecorder|captureStream/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
  assert.doesNotMatch(source, /postMessage\([^\n]*(?:mediaCredential|receiver-pin|sourceDeviceLabel)/);
  assert.match(source, /availability\.receiverReady === true && availability\.sessionStartAllowed === true/);
  assert.match(source, /\$\("#casting-workspace"\)\.hidden = !workspaceVisibleV1\(state\)/);
  assert.match(source, /reason\.textContent = availability\.outputs\[output\]\.reasonCode/);
});

test("release template is a device-free, host-network-free ApplicationPlugin", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.wireless-casting");
  assert.equal(manifest.type, "ApplicationPlugin");
  assert.equal(manifest.entryPoints.web.path, "/plugins/official.wireless-casting");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.deepEqual(manifest.themes.supported, ["light", "dark"]);
  assert.deepEqual(manifest.permissions.devices, []);
  assert.deepEqual(manifest.permissions.objectNamespaces, []);
  assert.deepEqual(manifest.permissions.network, { mode: "none", egressHosts: [] });
  assert.equal(manifest.resources.persistentStorageBytes, 0);
  const release = structuredClone(manifest);
  release.images[0].variants[0].reference = "registry.teamaibox.local/official/wireless-casting:0.1.0";
  release.images[0].variants[0].digest = `sha256:${"a".repeat(64)}`;
  release.signature.keyId = "teamaibox.official/release-2026";
  release.signature.payloadDigest = `sha256:${"b".repeat(64)}`;
  release.signature.value = Buffer.alloc(64).toString("base64");
  assert.equal(validatePluginManifest(release, { verifyPayloadDigest: false }).pluginId, "official.wireless-casting");
});

test("Web catalog route and translations are source-wired without deployment evidence", async () => {
  const routes = JSON.parse(await readFile(new URL("../../../deploy/plugins/web-routes.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(routes.routes.find((route) => route.pluginId === "official.wireless-casting"), {
    pluginId: "official.wireless-casting",
    pathPrefix: "/plugins/official.wireless-casting",
    origin: "http://wireless-casting-plugin:8080",
  });
  const shell = await readFile(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../../web/src/i18n.ts", import.meta.url), "utf8");
  assert.match(shell, /cast: Cast/);
  assert.equal((i18n.match(/"app\.wireless-casting\.name"/g) ?? []).length, 2);
  assert.equal((i18n.match(/"app\.wireless-casting\.description"/g) ?? []).length, 2);
});
