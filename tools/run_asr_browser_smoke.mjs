#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^asr-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class AsrBrowserSmokeError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new AsrBrowserSmokeError(message); };
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sortValue(value)));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    requireValue(argv[index]?.startsWith("--") && argv[index + 1], "ASR browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "short-fixture", "long-fixture", "output", "screenshots"]) {
    requireValue(typeof values[key] === "string", `ASR browser ${key} is required`);
  }
  const origin = new URL(values.origin);
  requireValue(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "ASR browser requires an exact HTTPS appliance origin");
  requireValue(RUN_ID.test(values["run-id"]), "ASR browser run ID is invalid");
  const result = {
    origin: origin.href,
    runId: values["run-id"],
    deploymentEvidence: resolve(values["deployment-evidence"]),
    shortFixture: resolve(values["short-fixture"]),
    longFixture: resolve(values["long-fixture"]),
    output: resolve(values.output), screenshots: resolve(values.screenshots),
    chrome: values.chrome ?? DEFAULT_CHROME,
  };
  for (const path of [result.deploymentEvidence, result.shortFixture, result.longFixture, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    requireValue(scoped && scoped !== ".." && !scoped.startsWith("../"), "ASR browser artifact escapes the repository");
  }
  return result;
}

async function credentialsFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const accounts = [
      { key: "owner", role: "owner", value: value.owner },
      { key: "ordinary-user", role: "member", value: value.member },
    ];
    for (const account of accounts) {
      requireValue(typeof account.value?.loginName === "string" && typeof account.value?.password === "string"
        && account.value.password.length >= 8, `ASR browser ${account.key} credential is unavailable`);
    }
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

async function waitJson(url, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return await response.json(); }
    catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new AsrBrowserSmokeError(`Chrome DevTools did not become ready: ${lastError?.message ?? "timeout"}`);
}

class Cdp {
  #socket; #nextId = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const client = new Cdp(); client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener("open", resolvePromise, { once: true });
      client.#socket.addEventListener("error", () => reject(new AsrBrowserSmokeError("Chrome DevTools WebSocket failed")), { once: true });
    });
    client.#socket.addEventListener("message", (event) => client.#message(event));
    return client;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const pending = this.#pending.get(value.id); if (!pending) return;
      this.#pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new AsrBrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`));
      else pending.resolve(value.result ?? {});
      return;
    }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) { const handlers = this.#events.get(method) ?? []; handlers.push(handler); this.#events.set(method, handlers); }
  waitEvent(method, predicate, label, timeoutMilliseconds = 30_000) {
    return new Promise((resolvePromise, reject) => {
      const handlers = this.#events.get(method) ?? [];
      const timer = setTimeout(() => {
        this.#events.set(method, handlers.filter((item) => item !== handler));
        reject(new AsrBrowserSmokeError(`${label} event timed out`));
      }, timeoutMilliseconds);
      const handler = (value) => {
        if (!predicate(value)) return;
        clearTimeout(timer);
        this.#events.set(method, handlers.filter((item) => item !== handler));
        resolvePromise(value);
      };
      handlers.push(handler); this.#events.set(method, handlers);
    });
  }
  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AsrBrowserSmokeError(`CDP ${method} timed out`));
      }, 20_000);
      this.#pending.set(id, { method, resolve: resolvePromise, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new AsrBrowserSmokeError(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "browser evaluation failed");
    return result.result?.value;
  }
  async wait(expression, label, timeoutMilliseconds = 30_000) {
    const deadline = Date.now() + timeoutMilliseconds; let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      if (last?.ready === true) return last;
      await sleep(200);
    }
    throw new AsrBrowserSmokeError(`${label} did not become ready${last === undefined ? "" : `: ${JSON.stringify(last).slice(0, 300)}`}`);
  }
  close() {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AsrBrowserSmokeError(`CDP ${pending.method} was interrupted by browser shutdown`));
    }
    this.#pending.clear();
    this.#socket.close();
  }
}

function valueSetter(selector, value) {
  return `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return false; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event("input",{bubbles:true})); element.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`;
}

function frame(expression) {
  return `(() => { const iframe=globalThis.document.querySelector('iframe[src^="/plugins/official.asr"]'); const frameDocument=iframe?.contentDocument; if(!frameDocument) return null; const document=frameDocument; return (${expression}); })()`;
}

async function signIn(cdp, origin, account) {
  const normalized = new URL(origin).origin;
  await cdp.send("Page.navigate", { url: "about:blank" });
  await cdp.wait(`(() => ({ready:location.href==="about:blank"}))()`, `${account.key} isolated browser context`);
  await cdp.send("Storage.clearDataForOrigin", { origin: normalized, storageTypes: "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers" });
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Page.navigate", { url: new URL("health/ready", origin).href });
  await cdp.wait(`(() => ({ready:location.pathname==="/health/ready"}))()`, `${account.key} same-origin storage reset`);
  await cdp.evaluate(`(() => { sessionStorage.clear(); localStorage.clear(); return true; })()`);
  await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)}))()`, `${account.key} sign-in form`);
  requireValue(await cdp.evaluate(valueSetter("#login-name", account.value.loginName)) === true, `${account.key} login input is missing`);
  requireValue(await cdp.evaluate(valueSetter("#login-password", account.value.password)) === true, `${account.key} password input is missing`);
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null}))()`, `${account.key} authenticated workspace`);
}

async function openAsr(cdp, account, { expectedExperimental = null, expectedWordTimestampsDisabled = null } = {}) {
  const card = await cdp.wait(`(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>/语音转写|Speech Transcription/.test(item.innerText)); return {ready:Boolean(button&&!button.disabled),found:Boolean(button),disabled:button?.disabled??null}; })()`, `${account.key} ASR catalog card`, 30_000);
  requireValue(card.found && card.disabled === false, `${account.key} ASR catalog card is not launchable`);
  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>/语音转写|Speech Transcription/.test(item.innerText)); button.click(); return true; })()`);
  const opened = await cdp.wait(frame(`(() => { const error=document.querySelector("#form-error"),badge=document.querySelector("#model-tier"),word=document.querySelector("#word-timestamps"); return {ready:document.readyState==="complete"&&Boolean(document.querySelector("#submit"))&&!error?.textContent,title:document.querySelector("h1")?.textContent||null,experimental:badge?.textContent||null,experimentalVisible:badge?.hidden===false,speakersDisabled:document.querySelector("#speakers")?.disabled===true,wordTimestampsDisabled:word?.disabled===true,wordHint:word?.closest("label")?.querySelector("small")?.textContent||null,error:error?.textContent||null}; })()`), `${account.key} ASR iframe`, 30_000);
  requireValue(opened.speakersDisabled && (!opened.experimentalVisible || /实验|Experimental/.test(opened.experimental ?? "")),
    `${account.key} ASR capability disclosure drifted`);
  if (expectedExperimental !== null) requireValue(opened.experimentalVisible === expectedExperimental,
    `${account.key} ASR model tier disclosure drifted`);
  if (expectedWordTimestampsDisabled !== null) requireValue(opened.wordTimestampsDisabled === expectedWordTimestampsDisabled
    && (!expectedWordTimestampsDisabled || /仅支持分段|segment timestamps only/.test(opened.wordHint ?? "")),
    `${account.key} ASR timestamp capability disclosure drifted`);
  return opened;
}

async function selectSyntheticAudio(cdp, fixturePath) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: frame(`document.querySelector("#file")`), awaitPromise: false, returnByValue: false,
  });
  const objectId = result.result?.objectId;
  requireValue(typeof objectId === "string", "ASR browser file input is missing");
  await cdp.send("DOM.setFileInputFiles", { files: [fixturePath], objectId });
  requireValue(await cdp.evaluate(frame(`(() => { const input=document.querySelector("#file"); input.dispatchEvent(new Event("input",{bubbles:true})); input.dispatchEvent(new Event("change",{bubbles:true})); return input.files?.length===1; })()`)) === true,
    "ASR synthetic audio selection failed");
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#selected")?.hidden===false&&document.querySelector("#audio-preview")?.hidden===false,name:document.querySelector("#file-name")?.textContent||null,error:document.querySelector("#form-error")?.textContent||null}))()`), "ASR selected audio preview");
}

async function submitAsr(cdp, { wordTimestamps, cancelImmediately = false }) {
  if (wordTimestamps) await cdp.evaluate(frame(`(() => { const input=document.querySelector("#word-timestamps"); input.checked=true; input.dispatchEvent(new Event("change",{bubbles:true})); document.querySelector("#format").value="srt"; return true; })()`));
  if (cancelImmediately) {
    const armed = await cdp.evaluate(`(() => {
      const iframe=document.querySelector('iframe[src^="/plugins/official.asr"]');
      const frameDocument=iframe?.contentDocument;
      const submit=frameDocument?.querySelector("#submit"),cancel=frameDocument?.querySelector("#cancel");
      if(!submit||!cancel)return false;
      const deadline=Date.now()+60000;
      const timer=setInterval(()=>{
        if(Date.now()>deadline){clearInterval(timer);return}
        if(frameDocument.querySelector("#job")?.hidden===false&&!cancel.disabled){clearInterval(timer);cancel.click()}
      },25);
      submit.click(); return true;
    })()`);
    requireValue(armed === true, "ASR immediate cancellation monitor could not be armed");
    return null;
  }
  await cdp.evaluate(frame(`document.querySelector("#submit").click(),true`));
  return cdp.wait(frame(`(() => { const cancel=document.querySelector("#cancel"); const error=document.querySelector("#form-error")?.textContent||document.querySelector("#job-error")?.textContent||null; return {ready:document.querySelector("#job")?.hidden===false&&cancel?.disabled===false,status:document.querySelector("#status")?.dataset.status||null,error}; })()`), "ASR queued browser job", 60_000);
}

async function privateHttpsJson(url, { method = "GET", body = null, cookie = null } = {}) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  const response = await new Promise((resolvePromise, reject) => {
    const request = httpsRequest(url, {
      method, rejectUnauthorized: false,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (incoming) => {
      const chunks = []; let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) incoming.destroy(new AsrBrowserSmokeError("ASR browser verification response is too large"));
        else chunks.push(Buffer.from(chunk));
      });
      incoming.on("end", () => resolvePromise({ status: incoming.statusCode, headers: incoming.headers, bytes: Buffer.concat(chunks, size) }));
      incoming.on("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(new AsrBrowserSmokeError("ASR browser verification request timed out")));
    request.once("error", reject);
    if (payload) request.end(payload); else request.end();
  });
  payload?.fill(0);
  let value;
  try { value = JSON.parse(response.bytes.toString("utf8")); }
  finally { response.bytes.fill(0); }
  return { status: response.status, headers: response.headers, value };
}

async function browserSessionCookie(cdp, origin) {
  const host = new URL(origin).hostname;
  const result = await cdp.send("Network.getAllCookies");
  const cookie = (result.cookies ?? []).filter((item) => item.domain === host && item.secure === true)
    .map((item) => `${item.name}=${item.value}`).join("; ");
  requireValue(cookie.length > 0, "ASR cancellation verification session cookie is missing");
  return cookie;
}

async function verifyMemberCancelledTask(origin, cookie, createdAfter) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const activity = await privateHttpsJson(new URL("api/v1/user/activity", origin), { cookie });
    requireValue(activity.status === 200 && Array.isArray(activity.value?.tasks),
      `ASR cancellation verification activity returned HTTP ${activity.status}`);
    if (activity.value.tasks.some((task) => task?.taskKind === "asr" && task.state === "cancelled"
      && new Date(task.createdAt).getTime() >= createdAfter.getTime())) return true;
    await sleep(100);
  }
  return false;
}

async function completeOwnerJourney(cdp, downloadDirectory, runId) {
  const states = new Set();
  const completed = await cdp.wait(frame(`(() => { const status=document.querySelector("#status")?.dataset.status||null; const error=document.querySelector("#form-error")?.textContent||document.querySelector("#job-error")?.textContent||null; const segments=document.querySelectorAll("#segments textarea").length; return {ready:status==="succeeded"&&document.querySelector("#transcript")?.hidden===false&&segments>0,status,error,segments,speaker:document.querySelector("#speaker-summary")?.textContent||null,provenance:document.querySelectorAll("#provenance span").length}; })()`), "owner ASR completion", 180_000);
  states.add(completed.status);
  requireValue(/不支持|does not support/.test(completed.speaker ?? "") && completed.provenance >= 2, "owner ASR speaker or provenance disclosure drifted");
  const marker = `${runId}-reviewed`;
  requireValue(await cdp.evaluate(frame(`(() => { const area=document.querySelector("#segments textarea"); if(!area)return false; area.value=area.value+" ${marker}"; area.dispatchEvent(new Event("input",{bubbles:true})); return area.value.endsWith(${JSON.stringify(marker)}); })()`)) === true, "owner transcript edit failed");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDirectory, eventsEnabled: true });
  await cdp.evaluate(frame(`document.querySelector("#export").click(),true`));
  const deadline = Date.now() + 20_000; let files = [];
  while (Date.now() < deadline) { files = (await readdir(downloadDirectory)).filter((item) => !item.endsWith(".crdownload")); if (files.length === 1) break; await sleep(100); }
  requireValue(files.length === 1, "owner transcript export did not download exactly one file");
  const exportBytes = await readFile(join(downloadDirectory, files[0]));
  const exportHasEdit = exportBytes.includes(Buffer.from(marker));
  exportBytes.fill(0);
  requireValue(exportHasEdit, "owner transcript export omitted the browser edit");
  await cdp.send("Page.reload", { ignoreCache: false });
  const retained = await cdp.wait(frame(`(() => { const status=document.querySelector("#status")?.dataset.status||null; const segments=document.querySelectorAll("#segments textarea").length; const error=document.querySelector("#job-error")?.textContent||null; return {ready:status==="succeeded"&&segments>0,status,segments,error}; })()`), "owner ASR reload retention", 60_000);
  return { stateCount: states.size, segmentCount: completed.segments, editApplied: true, exportDownloaded: true, reloadRetained: retained.segments > 0, speakerUnsupported: true };
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(captured.data, "base64");
  requireValue(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "ASR browser screenshot is invalid");
  const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new AsrBrowserSmokeError("ASR browser evidence exists; use a new run ID"); }).catch((error) => { if (error instanceof AsrBrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/);
  requireValue(identity, "ASR browser deployment identity is invalid");
  let webImageId, asrImageId;
  const currentCapabilityUi = deployment.runnerId === "teamaibox.current-asr-capability-ui-deployment.v1";
  const currentBatchRouting = deployment.runnerId === "teamaibox.current-batch-asr-routing-deployment.v1";
  if (currentCapabilityUi) {
    const batchPath = resolve(ROOT, deployment.parent?.path ?? "");
    requireValue(relative(ROOT, batchPath) && !relative(ROOT, batchPath).startsWith("../"), "current ASR UI parent escapes repository");
    const batchBytes = await readFile(batchPath), batch = JSON.parse(batchBytes);
    requireValue(digest(batchBytes) === deployment.parent?.digest && batch.runId === deployment.parent?.runId
      && batch.runnerId === "teamaibox.current-batch-asr-routing-deployment.v1", "current ASR UI parent drifted");
    const ownerPath = resolve(ROOT, batch.parent?.path ?? "");
    requireValue(relative(ROOT, ownerPath) && !relative(ROOT, ownerPath).startsWith("../"), "current ASR routing parent escapes repository");
    const ownerBytes = await readFile(ownerPath), owner = JSON.parse(ownerBytes);
    requireValue(digest(ownerBytes) === batch.parent?.digest && owner.runId === batch.parent?.runId, "current ASR routing parent drifted");
    webImageId = owner.runtime?.web?.imageId;
    asrImageId = deployment.runtime?.imageId;
    requireValue(deployment.status === "passed" && deployment.runtime?.wordTimestampsEnabled === false
      && SHA256.test(webImageId ?? "") && SHA256.test(asrImageId ?? ""), "current ASR UI browser deployment binding is invalid");
  } else if (currentBatchRouting) {
    const parentPath = resolve(ROOT, deployment.parent?.path ?? "");
    requireValue(relative(ROOT, parentPath) && !relative(ROOT, parentPath).startsWith("../"), "current ASR parent escapes repository");
    const parentBytes = await readFile(parentPath), parent = JSON.parse(parentBytes);
    requireValue(digest(parentBytes) === deployment.parent?.digest && parent.runId === deployment.parent?.runId,
      "current ASR deployment parent drifted");
    webImageId = parent.runtime?.web?.imageId;
    asrImageId = deployment.runtime?.worker?.imageId;
    requireValue(deployment.status === "passed" && SHA256.test(webImageId ?? "") && SHA256.test(asrImageId ?? "")
      && deployment.configuration?.TEAMAIBOX_ASR_WORKER_ORIGIN === "http://batch-asr-worker:8080",
      "current ASR browser deployment binding is invalid");
  } else {
    const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
    const web = deployment.imageBindings?.find((item) => item.component === "catalog-web");
    const asr = deployment.imageBindings?.find((item) => item.component === "catalog-asr");
    webImageId = web?.imageId ?? plan.environment?.TEAMAIBOX_CATALOG_WEB_IMAGE;
    asrImageId = asr?.imageId ?? plan.environment?.TEAMAIBOX_CATALOG_ASR_IMAGE;
    requireValue(deployment.status === "passed" && SHA256.test(webImageId ?? "") && SHA256.test(asrImageId ?? "")
      && plan.featureServices?.includes("asr-plugin"), "ASR browser deployment binding is invalid");
  }
  const shortBytes = await readFile(options.shortFixture), longBytes = await readFile(options.longFixture);
  const fixtureDigests = { short: digest(shortBytes), long: digest(longBytes) }; shortBytes.fill(0); longBytes.fill(0);
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-asr-browser-"));
  const downloads = join(profile, "downloads"); await mkdir(downloads);
  const port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync","--metrics-recording-only","--ignore-certificate-errors","--window-size=1440,900","about:blank"], { stdio: ["ignore","ignore","ignore"] });
  const startedAt = new Date().toISOString(), journeys = [], consoleErrors = [];
  let cdp, browser = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page");
    requireValue(target?.webSocketDebuggerUrl, "Chrome page target is unavailable");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => {
      const values = (event.args ?? []).map((item) => item.value);
      if (event.type === "error") consoleErrors.push(String(values[0] ?? "console error").slice(0, 300));
    });
    await Promise.all([cdp.send("Page.enable"),cdp.send("Runtime.enable"),cdp.send("Network.enable"),cdp.send("DOM.enable"),cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false})]);
    browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    const segmentOnly = currentCapabilityUi || currentBatchRouting;
    const owner = accounts[0]; await signIn(cdp, options.origin, owner); const ownerOpen = await openAsr(cdp, owner, { expectedExperimental: !segmentOnly, expectedWordTimestampsDisabled: segmentOnly });
    await selectSyntheticAudio(cdp, options.shortFixture); await submitAsr(cdp, { wordTimestamps: !segmentOnly });
    const ownerResult = await completeOwnerJourney(cdp, downloads, options.runId); const ownerShot = await screenshot(cdp, options.screenshots, owner.key);
    journeys.push({ key: owner.key, role: owner.role, launchable: true, experimentalBadge: ownerOpen.experimentalVisible === true, audioSelected: true, wordTimestamps: !segmentOnly, transcriptCompleted: true, timelineSegmentCount: ownerResult.segmentCount, editApplied: ownerResult.editApplied, exportDownloaded: ownerResult.exportDownloaded, reloadRetained: ownerResult.reloadRetained, cancelled: false, speakerUnsupported: ownerResult.speakerUnsupported, screenshot: ownerShot });

    const member = accounts[1]; await signIn(cdp, options.origin, member); const memberOpen = await openAsr(cdp, member, { expectedExperimental: !segmentOnly, expectedWordTimestampsDisabled: segmentOnly });
    const memberCookie = await browserSessionCookie(cdp, options.origin);
    const memberSubmissionStartedAt = new Date();
    await selectSyntheticAudio(cdp, options.longFixture);
    const memberShot = await screenshot(cdp, options.screenshots, member.key);
    await submitAsr(cdp, { wordTimestamps: false, cancelImmediately: true });
    requireValue(await verifyMemberCancelledTask(options.origin, memberCookie, memberSubmissionStartedAt),
      "member ASR cancellation was not visible in the authenticated own-task view");
    await sleep(250);
    const memberCancelled = true;
    journeys.push({ key: member.key, role: member.role, launchable: true, experimentalBadge: memberOpen.experimentalVisible === true, audioSelected: true, wordTimestamps: false, transcriptCompleted: false, timelineSegmentCount: 0, editApplied: false, exportDownloaded: false, reloadRetained: false, cancelled: memberCancelled, speakerUnsupported: true, screenshot: memberShot });
    requireValue(consoleErrors.length === 0, `ASR browser emitted ${consoleErrors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally {
    cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]); await rm(profile, { recursive: true, force: true });
    for (const account of accounts) account.value.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 1, runnerId: "teamaibox.asr-browser-smoke.v1", runId: options.runId, featureKey: "official.asr",
    status: failure ? "failed" : "passed", classification: "component-canary-self-signed-https", releaseEvidenceEligible: false,
    origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser, journeys,
    console: { errorCount: consoleErrors.length },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), shortFixtureDigest: fixtureDigests.short, longFixtureDigest: fixtureDigests.long },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId, asrImageId },
    privacy: { credentialsRetained: false, userContentRetained: false, syntheticTranscriptScreenshotRetained: true, commandOutputRetained: false, syntheticContentOnly: true },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new AsrBrowserSmokeError(`ASR browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({runId:evidence.runId,status:evidence.status,journeyCount:journeys.length,evidence:relative(ROOT,options.output)})}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "ASR browser smoke failed"}\n`); process.exitCode = 1; });
