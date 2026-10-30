import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createAsrPluginServer } from "../src/server.mjs";

async function fixture() {
  const server = createAsrPluginServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("serves a namespaced ASR application with protected media, durable progress, timeline, and export", async () => {
  const app = await fixture();
  try {
    const health = await fetch(app.origin + "/health/ready");
    assert.deepEqual(await health.json(), { status: "ready", pluginId: "official.asr", version: "0.1.0" });
    const html = await (await fetch(app.origin + "/plugins/official.asr")).text();
    assert.match(html, /accept="audio\/wav,[^"]+video\/mp4,video\/webm/);
    assert.match(html, /id="model-tier"[^>]+data-i18n="experimental"/);
    assert.match(html, /data-source="drive"/);
    assert.match(html, /data-source="live"/);
    assert.match(html, /id="live-toggle"/);
    assert.match(html, /id="live-segments"/);
    assert.match(html, /id="word-timestamps"/);
    assert.match(html, /id="speakers"/);
    assert.match(html, /id="segments"/);
    assert.match(html, /id="export"/);
    assert.match(html, /id="handoff"/);
    const source = await (await fetch(app.origin + "/plugins/official.asr/app.js")).text();
    assert.match(source, /uploadObject/);
    assert.match(source, /capability:\s*['"]asr['"]/);
    assert.match(source, /\/api\/v1\/ai\/transcriptions/);
    assert.match(source, /\/api\/v1\/jobs\/\$\{state\.jobId\}\/cancel/);
    assert.match(source, /job\.progress\?\.value/);
    assert.doesNotMatch(source, /job\.progress\?\.message_key/);
    assert.match(source, /teamaibox\.ai\.asr-result\.v1/);
    assert.match(source, /speaker_information/);
    assert.match(source, /local\/asr-default/);
    assert.match(source, /"video\/mp4","video\/webm"/);
    assert.match(source, /file\.type\.startsWith\("video\/"\)\?"#video-preview":"#audio-preview"/);
    assert.match(source, /JOB_STORAGE_KEY="teamaibox:official\.asr:active-job"/);
    assert.match(source, /sessionStorage\.setItem\(JOB_STORAGE_KEY,state\.jobId\)/);
    assert.match(source, /error\.code==="job_not_found"/);
    assert.match(source, /sessionStorage\.removeItem\(JOB_STORAGE_KEY\)/);
    assert.match(source, /if\(state\.jobId\)void poll\(\)/);
    assert.match(source, /body:\{capability:"translation"\}/);
    assert.match(source, /teamaibox\.plugin-handoff\/v1/);
    assert.match(source, /object\.objectId/);
    assert.match(source, /navigator\.mediaDevices\?\.getUserMedia/);
    assert.match(source, /new WebSocket\(`\$\{scheme\}:?\/\//);
    assert.match(source, /realtime\.input_audio\.configure/);
    assert.match(source, /realtime\.transcription\.completed/);
    assert.match(source, /new MediaRecorder\(live\.stream/);
    assert.match(source, /audio\/webm;codecs=opus/);
    assert.match(source, /split\(";",1\)\[0\]/);
    assert.match(source, /content_type:liveContentType\(\)/);
    assert.match(source, /expires_in_seconds:900/);
    assert.match(source, /window\.addEventListener\("pagehide",\(\)=>stopLive\(\)\)/);
    assert.match(source, /messages\["zh-CN"\]\.segmentEditor="转写片段 \{time\}"/);
    assert.match(source, /messages\.en\.segmentEditor="Transcript segment \{time\}"/);
    assert.match(source, /text\.ariaLabel=t\("segmentEditor",\{time:time\.textContent\}\)/);
  } finally { await app.close(); }
});

test("static ASR container is read-only and rejects unrelated filesystem paths", async () => {
  const app = await fixture();
  try {
    const mutation = await fetch(app.origin + "/plugins/official.asr", { method: "POST" });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get("allow"), "GET, HEAD");
    assert.equal((await fetch(app.origin + "/plugins/official.asr/%00/package.json")).status, 404);
    assert.equal((await fetch(app.origin + "/package.json")).status, 404);
  } finally { await app.close(); }
});

test("release template requires real OCI evidence and official signing", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.release-template.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "official.asr");
  assert.equal(manifest.type, "ApplicationPlugin");
  assert.deepEqual(manifest.compatibility.requiredCapabilities, ["asr", "encrypted-objects", "object-references", "durable-jobs"]);
  assert.deepEqual(manifest.localization.supportedLocales, ["zh-CN", "en"]);
  assert.match(manifest.images[0].variants[0].reference, /^__RELEASE_PIPELINE_MUST_SET_/);
  assert.match(manifest.signature.value, /^__RELEASE_PIPELINE_MUST_SIGN_/);
});
