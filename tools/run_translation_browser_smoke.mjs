#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^translation-browser-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
class TranslationBrowserSmokeError extends Error {}
const need = (value, message) => { if (!value) throw new TranslationBrowserSmokeError(message); };
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Translation browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "audio-fixture", "output", "screenshots"])
    need(typeof values[key] === "string", `Translation browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "Translation browser requires an exact HTTPS appliance origin");
  need(RUN_ID.test(values["run-id"]), "Translation browser run ID is invalid");
  const options = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]),
    audioFixture: resolve(values["audio-fixture"]), output: resolve(values.output), screenshots: resolve(values.screenshots),
    chrome: values.chrome ?? DEFAULT_CHROME };
  for (const path of [options.deploymentEvidence, options.audioFixture, options.output, options.screenshots]) {
    const scoped = relative(ROOT, path);
    need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Translation browser artifact escapes the repository");
  }
  return options;
}

async function credentialsFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const accounts = [{ key: "owner", role: "owner", value: value.owner },
      { key: "ordinary-user", role: "member", value: value.member }];
    for (const account of accounts) need(typeof account.value?.loginName === "string"
      && typeof account.value?.password === "string" && account.value.password.length >= 8,
    `Translation browser ${account.key} credential is unavailable`);
    return accounts;
  } finally { raw.fill(0); }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitJson(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await sleep(100);
  }
  throw new TranslationBrowserSmokeError("Chrome DevTools did not become ready");
}

class Cdp {
  #socket; #nextId = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const client = new Cdp(); client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => { client.#socket.addEventListener("open", resolvePromise, { once: true });
      client.#socket.addEventListener("error", reject, { once: true }); });
    client.#socket.addEventListener("message", (event) => client.#message(event)); return client;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id);
      clearTimeout(pending.timer); value.error ? pending.reject(new TranslationBrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`))
        : pending.resolve(value.result ?? {}); return; }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) { const handlers = this.#events.get(method) ?? []; handlers.push(handler); this.#events.set(method, handlers); }
  send(method, params = {}) { const id = this.#nextId++; return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { this.#pending.delete(id); reject(new TranslationBrowserSmokeError(`CDP ${method} timed out`)); }, 30_000);
    this.#pending.set(id, { method, resolve: resolvePromise, reject, timer }); this.#socket.send(JSON.stringify({ id, method, params }));
  }); }
  async evaluate(expression, { byValue = true } = {}) { const result = await this.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: byValue, userGesture: true });
    if (result.exceptionDetails) throw new TranslationBrowserSmokeError(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text ?? "browser evaluation failed"); return byValue ? result.result?.value : result.result;
  }
  async wait(expression, label, timeoutMilliseconds = 60_000) { const deadline = Date.now() + timeoutMilliseconds; let last;
    while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      if (last?.ready === true) return last; await sleep(250); }
    throw new TranslationBrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 320)}`);
  }
  close() { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new TranslationBrowserSmokeError("browser shutdown")); }
    this.#pending.clear(); this.#socket.close(); }
}

const setter = (selector, value) => `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return false;
  const prototype=element.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(value)});
  element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true; })()`;
const frame = (plugin, expression) => `(() => { const iframe=globalThis.document.querySelector('iframe[src^="/plugins/${plugin}"]');
  const frameDocument=iframe?.contentDocument;if(!frameDocument)return null;const document=frameDocument;return (${expression}); })()`;

async function signIn(cdp, origin, account) {
  const normalized = new URL(origin).origin;
  await cdp.send("Page.navigate", { url: "about:blank" });
  await cdp.wait(`(() => ({ready:location.href==="about:blank"}))()`, `${account.key} isolated context`);
  await cdp.send("Storage.clearDataForOrigin", { origin: normalized,
    storageTypes: "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers" });
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)}))()`, `${account.key} sign-in`, 30_000);
  need(await cdp.evaluate(setter("#login-name", account.value.loginName)), `${account.key} login input is missing`);
  need(await cdp.evaluate(setter("#login-password", account.value.password)), `${account.key} password input is missing`);
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null}))()`, `${account.key} workspace`, 30_000);
}

async function navigateHome(cdp, origin) {
  await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame")&&document.querySelectorAll("button.application-card").length)}))()`, "application workbench", 30_000);
}

async function isolateTranslationJourney(cdp) {
  need(await cdp.evaluate(`(() => { sessionStorage.removeItem("teamaibox.translation.active-job.v1");return true; })()`),
    "Translation browser could not isolate the current journey");
}

async function openPlugin(cdp, { label, plugin, submit = "#submit" }) {
  await cdp.wait(`(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>${label}.test(item.innerText));
    return {ready:Boolean(button&&!button.disabled),found:Boolean(button),disabled:button?.disabled??null}; })()`, `${plugin} catalog card`, 30_000);
  await cdp.evaluate(`(() => { [...document.querySelectorAll("button.application-card")].find((item)=>${label}.test(item.innerText)).click();return true; })()`);
  return cdp.wait(frame(plugin, `(() => ({ready:document.readyState==="complete"&&Boolean(document.querySelector(${JSON.stringify(submit)})),
    experimental:document.querySelector("#model-tier")?.hidden===false,error:document.querySelector("#form-error")?.textContent||null}))()`), `${plugin} iframe`, 30_000);
}

async function setFile(cdp, plugin, fixture, selector = "#file") {
  const remote = await cdp.evaluate(frame(plugin, `document.querySelector(${JSON.stringify(selector)})`), { byValue: false });
  need(typeof remote?.objectId === "string", `${plugin} file input is missing`);
  await cdp.send("DOM.setFileInputFiles", { files: [fixture], objectId: remote.objectId });
  need(await cdp.evaluate(frame(plugin, `(() => { const input=document.querySelector(${JSON.stringify(selector)});
    input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));return input.files?.length===1; })()`)),
  `${plugin} file selection failed`);
}

async function waitTranslation(cdp, { stages, hasIntermediates, timeout = 240_000 }) {
  const result = await cdp.wait(frame("official.translation", `(() => { const status=document.querySelector("#status")?.dataset.status||null;
    const translated=document.querySelector("#translated-text")?.value||"";const error=document.querySelector("#form-error")?.textContent||document.querySelector("#job-error")?.textContent||null;
    return {ready:status==="succeeded"&&translated.length>0,status,translated,segments:document.querySelectorAll("#segments .segment").length,
      stages:[...document.querySelectorAll("#workflow-stages span")].map((item)=>item.textContent),intermediates:document.querySelectorAll("#intermediates button").length,error}; })()`), "Translation result", timeout);
  need(result.segments >= 1 && result.stages.length === stages.length
    && stages.every((stage) => result.stages.some((value) => value.startsWith(stage))), "Translation browser workflow stages drifted");
  need(hasIntermediates ? result.intermediates >= 1 : result.intermediates === 0, "Translation intermediate disclosure drifted");
  await sleep(500);
  const settled = await cdp.evaluate(frame("official.translation", `(() => { const bar=document.querySelector("#progress-bar"),track=bar?.parentElement;
    const detail=document.querySelector("#detail")?.textContent||"";return {ratio:bar&&track?bar.getBoundingClientRect().width/track.getBoundingClientRect().width:0,
      detail,percent:document.querySelector("#percent")?.textContent||""}; })()`));
  need(settled.ratio >= 0.98 && settled.percent === "100%" && !/tasks\.|state\./.test(settled.detail),
    "Translation terminal progress did not settle or exposed an internal message key");
  return result;
}

async function download(cdp, directory, action, label) {
  const before = new Set(await readdir(directory)); await action(); const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const files = (await readdir(directory)).filter((item) => !item.endsWith(".crdownload") && !before.has(item));
    if (files.length === 1) { const path = join(directory, files[0]); const bytes = await readFile(path); need(bytes.byteLength > 2, `${label} export is empty`); bytes.fill(0); return true; }
    await sleep(100); }
  throw new TranslationBrowserSmokeError(`${label} export did not download`);
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(captured.data, "base64"); need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "Translation screenshot is invalid");
  const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

function onePagePdf() {
  const stream = "BT\n/F1 42 Tf\n72 650 Td\n(TEAM AI BOX) Tj\n0 -80 Td\n/F1 30 Tf\n(PRIVATE BROWSER TRANSLATION 2026) Tj\nET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let output = "%PDF-1.4\n%TeamAIBox\n"; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

async function submitDirectText(cdp, downloads, runId) {
  const opened = await openPlugin(cdp, { label: "/翻译|Translation/", plugin: "official.translation" });
  need(opened.experimental, "Translation experimental badge is missing");
  const source = `团队人工智能盒子保护私有数据 ${runId}`;
  need(await cdp.evaluate(frame("official.translation", setter("#source-text", source))), "Translation text input is missing");
  await cdp.evaluate(frame("official.translation", `document.querySelector("#submit").click(),true`));
  const result = await waitTranslation(cdp, { stages: ["translation"], hasIntermediates: false });
  need(result.translated !== source, "Translation browser echoed the source text");
  await download(cdp, downloads, () => cdp.evaluate(frame("official.translation", `document.querySelector("#export").click(),true`)), "text Translation");
  await cdp.send("Page.reload", { ignoreCache: false });
  const retained = await waitTranslation(cdp, { stages: ["translation"], hasIntermediates: false, timeout: 60_000 });
  return { launchable: true, experimentalBadge: true, completed: true, alignedSegments: retained.segments,
    exported: true, reloadRetained: true };
}

async function directDocument(cdp, origin, fixture) {
  await isolateTranslationJourney(cdp); await navigateHome(cdp, origin);
  await openPlugin(cdp, { label: "/翻译|Translation/", plugin: "official.translation" });
  await cdp.evaluate(frame("official.translation", `document.querySelector('[data-source="upload"]').click(),true`));
  await setFile(cdp, "official.translation", fixture);
  await cdp.evaluate(frame("official.translation", `(() => { document.querySelector("#target-language").value="zh-CN";
    document.querySelector("#submit").click();return true; })()`));
  const result = await waitTranslation(cdp, { stages: ["ocr", "translation"], hasIntermediates: true });
  return { completed: true, stages: result.stages.length, intermediateVisible: result.intermediates >= 1 };
}

async function directAudio(cdp, origin, fixture) {
  await isolateTranslationJourney(cdp); await navigateHome(cdp, origin);
  await openPlugin(cdp, { label: "/翻译|Translation/", plugin: "official.translation" });
  await cdp.evaluate(frame("official.translation", `document.querySelector('[data-source="upload"]').click(),true`));
  await setFile(cdp, "official.translation", fixture);
  await cdp.evaluate(frame("official.translation", `(() => { document.querySelector("#target-language").value="zh-CN";
    document.querySelector("#format").value="vtt";document.querySelector("#submit").click();return true; })()`));
  const result = await waitTranslation(cdp, { stages: ["asr", "translation", "subtitle-compose"], hasIntermediates: true });
  return { completed: true, stages: result.stages.length, subtitleSegments: result.segments, intermediateVisible: result.intermediates >= 1 };
}

async function ocrHandoff(cdp, origin, fixture) {
  await isolateTranslationJourney(cdp); await navigateHome(cdp, origin);
  await openPlugin(cdp, { label: "/文字识别|Text Recognition/", plugin: "official.ocr" });
  await setFile(cdp, "official.ocr", fixture);
  await cdp.evaluate(frame("official.ocr", `document.querySelector("#submit").click(),true`));
  await cdp.wait(frame("official.ocr", `(() => ({ready:document.querySelector("#status")?.dataset.status==="succeeded"
    &&document.querySelector("#corrected-text")?.value.length>10,error:document.querySelector("#job-error")?.textContent||null}))()`), "OCR result before handoff", 180_000);
  await cdp.evaluate(frame("official.ocr", `document.querySelector("#handoff").click(),true`));
  await cdp.wait(frame("official.translation", `(() => ({ready:Boolean(document.querySelector("#drive-list .drive-item.is-selected")),
    text:document.querySelector("#drive-list")?.textContent||""}))()`), "OCR to Translation handoff", 30_000);
  await cdp.evaluate(frame("official.translation", `(() => { document.querySelector("#target-language").value="zh-CN";
    document.querySelector("#submit").click();return true; })()`));
  const result = await waitTranslation(cdp, { stages: ["translation"], hasIntermediates: false });
  return { sourceCompleted: true, routeChanged: true, scopedReferenceAccepted: true, extractionReused: true, translated: result.translated.length > 0 };
}

async function asrHandoff(cdp, origin, fixture) {
  await isolateTranslationJourney(cdp); await navigateHome(cdp, origin);
  await openPlugin(cdp, { label: "/语音转写|Speech Transcription/", plugin: "official.asr" });
  await setFile(cdp, "official.asr", fixture);
  await cdp.evaluate(frame("official.asr", `document.querySelector("#submit").click(),true`));
  await cdp.wait(frame("official.asr", `(() => ({ready:document.querySelector("#status")?.dataset.status==="succeeded"
    &&document.querySelector("#transcript")?.hidden===false&&document.querySelectorAll("#segments textarea").length>0,
    error:document.querySelector("#job-error")?.textContent||null}))()`), "ASR result before handoff", 180_000);
  await cdp.evaluate(frame("official.asr", `document.querySelector("#handoff").click(),true`));
  await cdp.wait(frame("official.translation", `(() => ({ready:Boolean(document.querySelector("#drive-list .drive-item.is-selected")),
    text:document.querySelector("#drive-list")?.textContent||""}))()`), "ASR to Translation handoff", 30_000);
  await cdp.evaluate(frame("official.translation", `(() => { document.querySelector("#target-language").value="zh-CN";
    document.querySelector("#format").value="vtt";document.querySelector("#submit").click();return true; })()`));
  const result = await waitTranslation(cdp, { stages: ["translation", "subtitle-compose"], hasIntermediates: false });
  return { sourceCompleted: true, routeChanged: true, scopedReferenceAccepted: true, transcriptionReused: true,
    translated: result.translated.length > 0, subtitleSegments: result.segments };
}

const options = argumentsFrom(process.argv.slice(2));
async function main() {
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new TranslationBrowserSmokeError("Translation browser evidence exists; use a new run ID"); })
    .catch((error) => { if (error instanceof TranslationBrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/);
  need(identity, "Translation browser deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  images["catalog-web"] ??= plan.environment?.TEAMAIBOX_CATALOG_WEB_IMAGE;
  images["catalog-translation"] ??= plan.environment?.TEAMAIBOX_CATALOG_TRANSLATION_IMAGE;
  images["catalog-ocr"] ??= plan.environment?.TEAMAIBOX_CATALOG_OCR_IMAGE;
  images["catalog-asr"] ??= plan.environment?.TEAMAIBOX_CATALOG_ASR_IMAGE;
  for (const component of ["catalog-web", "catalog-translation", "catalog-ocr", "catalog-asr"])
    need(deployment.status === "passed" && SHA256.test(images[component] ?? ""), `Translation browser deployment binding is missing ${component}`);
  need(["translation-plugin", "ocr-plugin", "asr-plugin"].every((service) => plan.featureServices?.includes(service)), "Translation composition services are absent");
  const audioBytes = await readFile(options.audioFixture), audioFixtureDigest = digest(audioBytes); audioBytes.fill(0);
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-translation-browser-")), downloads = join(profile, "downloads"); await mkdir(downloads);
  const pdfFixture = join(profile, "translation-validation.pdf"), pdfBytes = onePagePdf(), pdfFixtureDigest = digest(pdfBytes);
  await writeFile(pdfFixture, pdfBytes); pdfBytes.fill(0);
  const port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,
    "--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync",
    "--metrics-recording-only","--ignore-certificate-errors","--window-size=1440,900","about:blank"], { stdio: ["ignore","ignore","ignore"] });
  const startedAt = new Date().toISOString(), journeys = [], consoleErrors = []; let cdp, browser = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page");
    need(target?.webSocketDebuggerUrl, "Chrome page target is unavailable"); cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") consoleErrors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"),cdp.send("Runtime.enable"),cdp.send("Network.enable"),cdp.send("DOM.enable"),
      cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false}),
      cdp.send("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads,eventsEnabled:true})]);
    browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);
    await signIn(cdp, options.origin, accounts[0]); const text = await submitDirectText(cdp, downloads, options.runId);
    journeys.push({ key: "owner-text", account: "owner", role: "owner", ...text,
      screenshot: await screenshot(cdp, options.screenshots, "owner-text") });
    await signIn(cdp, options.origin, accounts[1]);
    const document = await directDocument(cdp, options.origin, pdfFixture);
    const audio = await directAudio(cdp, options.origin, options.audioFixture);
    journeys.push({ key: "member-direct-composition", account: "ordinary-user", role: "member", document, audio,
      screenshot: await screenshot(cdp, options.screenshots, "member-direct-composition") });
    const ocr = await ocrHandoff(cdp, options.origin, pdfFixture);
    const asr = await asrHandoff(cdp, options.origin, options.audioFixture);
    journeys.push({ key: "member-cross-app-handoff", account: "ordinary-user", role: "member", ocr, asr,
      screenshot: await screenshot(cdp, options.screenshots, "member-cross-app-handoff") });
    need(consoleErrors.length === 0, `Translation browser emitted ${consoleErrors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]);
    await rm(profile, { recursive: true, force: true }); for (const account of accounts) account.value.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.translation-browser-smoke.v1", runId: options.runId,
    featureKey: "official.translation", status: failure ? "failed" : "passed", classification: "component-canary-self-signed-https",
    releaseEvidenceEligible: false, origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser, journeys,
    console: { errorCount: consoleErrors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))),
      pdfFixtureDigest, audioFixtureDigest }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence),
      evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"],
      translationImageId: images["catalog-translation"], ocrImageId: images["catalog-ocr"], asrImageId: images["catalog-asr"] },
    privacy: { credentialsRetained: false, userContentRetained: false, syntheticScreenshotsRetained: true,
      commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "human-infrastructure-gate",
      videoTranslation: "not-deployed", translationModelCertification: "experimental" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new TranslationBrowserSmokeError(`Translation browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({runId:evidence.runId,status:evidence.status,journeyCount:journeys.length,evidence:relative(ROOT,options.output)})}\n`);
}
main().catch((error) => { process.stderr.write(`${error?.message ?? "Translation browser smoke failed"}\n`); process.exitCode = 1; });
