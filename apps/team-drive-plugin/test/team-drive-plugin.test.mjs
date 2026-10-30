import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePluginManifest } from "../../../services/plugin-runtime/src/manifest-validator.mjs";
import { createTeamDrivePluginServer } from "../src/server.mjs";
import { Sha256, sha256Blob } from "../src/public/sha256.js";

async function fixture() {
  const server = createTeamDrivePluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves a responsive Team Drive application and bounded static surface", async () => {
  const app = await fixture();
  try {
    assert.deepEqual(await (await fetch(app.origin + "/health/ready")).json(), { status: "ready", pluginId: "official.team-drive", version: "0.1.0" });
    const html = await (await fetch(app.origin + "/plugins/official.team-drive")).text();
    assert.match(html, /class="drive-shell"/); assert.match(html, /id="file-list"/); assert.match(html, /id="upload-panel"/); assert.match(html, /id="details"/);
    const css = await (await fetch(app.origin + "/plugins/official.team-drive/app.css")).text();
    assert.match(css, /\[hidden\]\{display:none!important\}/); assert.match(css, /@media\(max-width:700px\)/); assert.match(css, /data-theme="dark"/);
    assert.equal((await fetch(app.origin + "/plugins/official.team-drive", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.origin + "/plugins/official.team-drive/%00/package.json")).status, 404);
    assert.equal((await fetch(app.origin + "/package.json")).status, 404);
  } finally { await app.close(); }
});

test("incremental SHA-256 matches platform cryptographic vectors without buffering a large Blob", async () => {
  for (const value of ["", "abc", "a".repeat(1000), "团队网盘的分片校验"]) {
    const bytes = new TextEncoder().encode(value), expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(new Sha256().update(bytes.subarray(0, 1)).update(bytes.subarray(1)).digestHex(), expected);
    assert.equal(await sha256Blob(new Blob([bytes]), { chunkBytes: 7 }), expected);
  }
  const large = new Uint8Array(32 * 1024 * 1024 + 1).fill(0x61);
  const expected = createHash("sha256").update(large).digest("hex"), started = performance.now();
  assert.equal(await sha256Blob(new Blob([large])), expected);
  assert.ok(performance.now() - started < 10_000, "32 MiB browser-compatible hashing exceeded its bounded budget");
  large.fill(0);
});

test("production client implements server-authoritative resume and all file operations without fixture data or credentials", async () => {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  for (const route of [
    "/api/v1/files/bootstrap", "/api/v1/files/roots/", "/api/v1/files/entries/",
    "/api/v1/objects/multipart", "/api/v1/objects/uploads?capability=team_drive",
  ]) assert.ok(source.includes(route), route);
  assert.match(source, /serverParts=list\(await json/);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /schemaVersion:1,uploadId/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(?:token|credential|content)/i);
  assert.doesNotMatch(source, /mockFiles|demoFiles|sampleFiles|fixtureFiles/);
  assert.match(source, /\/copy`/); assert.match(source, /\/trash`/); assert.match(source, /\/restore`/); assert.match(source, /\/shares`/); assert.match(source, /\/preview/); assert.match(source, /\/download/);
  assert.match(source, /response\.status===403\?txt\("permissionDenied"\)/);
  assert.match(source, /permissionDenied:"你没有执行此操作的权限。"/);
  assert.match(source, /\/api\/v1\/identities\/directory\?limit=50/);
  assert.match(source, /OPAQUE_FILENAME/);
  assert.match(source, /originalFilename/);
});

test("release template declares delegated file APIs, no egress, and signed ARM64 evidence", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.team-drive");
  assert.equal(manifest.ui.displayNameKey, "app.drive.name");
  assert.equal(manifest.ui.summaryKey, "app.drive.description");
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.deepEqual(manifest.themes.supported, ["light", "dark"]);
  assert.deepEqual(manifest.apis.map((value) => value.name), ["platform.files", "platform.objects"]);
  assert.deepEqual(manifest.permissions.platformApiScopes, ["files:read", "files:write"]);
  assert.equal(manifest.permissions.network.mode, "none");
  const release = structuredClone(manifest);
  release.images[0].variants[0].reference = "registry.teamaibox.local/official/team-drive:0.1.0";
  release.images[0].variants[0].digest = `sha256:${"a".repeat(64)}`;
  release.signature.keyId = "teamaibox.official/release-2026";
  release.signature.payloadDigest = `sha256:${"b".repeat(64)}`;
  release.signature.value = Buffer.alloc(64).toString("base64");
  assert.equal(validatePluginManifest(release, { verifyPayloadDigest: false }).pluginId, "official.team-drive");
});

test("browser evidence covers responsive locales, themes, navigation, preview, search, and recycle", async () => {
  const evidence = JSON.parse(await readFile(new URL("../../../architecture/validation/team-drive-browser-validation.v1.json", import.meta.url), "utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.nativeMobileClientRequired, false);
  assert.equal(evidence.productionFixtureData, false);
  assert.ok(evidence.viewports.some((value) => value.width >= 1280 && value.locale === "zh-CN" && value.theme === "dark"));
  assert.ok(evidence.viewports.some((value) => value.width <= 390 && value.locale === "zh-CN" && value.theme === "dark"));
  assert.ok(evidence.viewports.some((value) => value.locale === "en" && value.theme === "light"));
  assert.deepEqual(evidence.console, { errors: 0, warnings: 0 });
  assert.ok(evidence.interactions.includes("recycle-bin retention view"));
  assert.ok(evidence.defectsFoundAndClosed.some((value) => value.id === "team-drive-mobile-action-accessible-name"));
});

test("the off-canvas details pane leaves the accessibility tree when closed", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="details"[^>]+aria-hidden="true"[^>]+inert[^>]+hidden/);
  assert.match(html, /id="search"[^>]+data-i18n-aria="search"[^>]+aria-label="搜索文件与文件夹"/);
  assert.match(source, /row\.setAttribute\("aria-label",`\$\{entry\.name\}, \$\{entry\.kind==="folder"\?txt\("folder"\):txt\("file"\)\}`\)/);
  assert.match(source, /pane\.hidden=false/);
  assert.match(source, /pane\.inert=false/);
  assert.match(source, /pane\.setAttribute\("aria-hidden","false"\)/);
  assert.match(source, /state\.selected=null;pane\.classList\.remove\("is-open"\);pane\.inert=true;pane\.setAttribute\("aria-hidden","true"\);pane\.hidden=true/);
  assert.match(source, /queueMicrotask\(\(\)=>\$\("#refresh"\)\.focus\(\)\)/);
});
