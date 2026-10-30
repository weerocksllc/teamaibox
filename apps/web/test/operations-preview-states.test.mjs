import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const preview = await readFile(new URL("../tools/operations-preview-server.mjs", import.meta.url), "utf8");

test("visual preview supports bounded ready, loading-delay, empty, and error fixtures", () => {
  assert.match(preview, /TEAMAIBOX_PREVIEW_RESPONSE_DELAY_MS/);
  assert.match(preview, /responseDelayMilliseconds < 0 \|\| responseDelayMilliseconds > 5000/);
  assert.match(preview, /new Set\(\["ready", "empty", "error"\]\)/);
  assert.match(preview, /previewDataState === "error" && pathname\.startsWith\("\/api\/"\)/);
  assert.match(preview, /previewDataState === "empty" \? \[\] :/);
  assert.match(preview, /summary: \{ total: 0, active: 0, waiting: 0, failed: 0 \}/);
});

test("visual preview mounts every official application-plugin surface", () => {
  for (const pluginId of ["drawing", "ocr", "asr", "translation", "messaging", "team-drive"]) {
    assert.match(preview, new RegExp(`official\\.${pluginId.replace("-", "\\-")}`));
  }
  assert.match(preview, /servePluginAsset\(pathname, response\)/);
  assert.match(preview, /\[hidden\]\{display:none!important\}/);
  assert.match(preview, /applicationPluginSharedAsset\(relative\)/);
  assert.match(preview, /application-plugin-runtime\/src\/static-server\.mjs/);
  assert.match(preview, /"\.mjs": "text\/javascript; charset=utf-8"/);
});

test("unknown preview APIs fail as JSON instead of falling through to the SPA", () => {
  assert.match(preview, /pathname\.startsWith\("\/api\/"\).*preview_route_unavailable.*404/);
});

test("visual preview is explicitly synthetic and never release-evidence eligible", () => {
  assert.match(preview, /classification:\"isolated-development-synthetic-only\"/);
  assert.match(preview, /releaseEvidenceEligible:false/);
  assert.match(preview, /transport:\"http\"/);
});
