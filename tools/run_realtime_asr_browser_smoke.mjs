#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^realtime-asr-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class RealtimeAsrBrowserError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new RealtimeAsrBrowserError(message); };
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sortValue(value)));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    requireValue(argv[index]?.startsWith("--") && argv[index + 1], "realtime ASR browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "audio-fixture", "output", "screenshots"]) {
    requireValue(typeof values[key] === "string", `realtime ASR browser ${key} is required`);
  }
  const origin = new URL(values.origin);
  requireValue(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "realtime ASR browser requires an exact HTTPS appliance origin");
  requireValue(RUN_ID.test(values["run-id"]), "realtime ASR browser run ID is invalid");
  const result = {
    origin: origin.href,
    runId: values["run-id"],
    deploymentEvidence: resolve(values["deployment-evidence"]),
    audioFixture: resolve(values["audio-fixture"]),
    output: resolve(values.output),
    screenshots: resolve(values.screenshots),
    runtimeBinding: values["runtime-binding"] ? resolve(values["runtime-binding"]) : null,
    chrome: values.chrome ?? DEFAULT_CHROME,
  };
  for (const path of [result.deploymentEvidence, result.audioFixture, result.output, result.screenshots, result.runtimeBinding].filter(Boolean)) {
    const scoped = relative(ROOT, path);
    requireValue(scoped && scoped !== ".." && !scoped.startsWith("../"), "realtime ASR browser artifact escapes the repository");
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
        && account.value.password.length >= 8, `realtime ASR ${account.key} credential is unavailable`);
    }
    return accounts;
  } finally { raw.fill(0); }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitJson(url, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new RealtimeAsrBrowserError(`Chrome DevTools did not become ready: ${lastError?.message ?? "timeout"}`);
}

class Cdp {
  #socket; #nextId = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const client = new Cdp();
    client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener("open", resolvePromise, { once: true });
      client.#socket.addEventListener("error", () => reject(new RealtimeAsrBrowserError("Chrome DevTools WebSocket failed")), { once: true });
    });
    client.#socket.addEventListener("message", (event) => client.#message(event));
    return client;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const pending = this.#pending.get(value.id);
      if (!pending) return;
      this.#pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new RealtimeAsrBrowserError(`CDP ${pending.method} failed: ${value.error.message}`));
      else pending.resolve(value.result ?? {});
      return;
    }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) {
    const handlers = this.#events.get(method) ?? [];
    handlers.push(handler);
    this.#events.set(method, handlers);
  }
  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RealtimeAsrBrowserError(`CDP ${method} timed out`));
      }, 30_000);
      this.#pending.set(id, { method, resolve: resolvePromise, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      throw new RealtimeAsrBrowserError(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "browser evaluation failed");
    }
    return result.result?.value;
  }
  async wait(expression, label, timeoutMilliseconds = 30_000) {
    const deadline = Date.now() + timeoutMilliseconds;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      if (last?.ready === true) return last;
      await sleep(200);
    }
    throw new RealtimeAsrBrowserError(`${label} did not become ready${last === undefined ? "" : `: ${JSON.stringify(last).slice(0, 600)}`}`);
  }
  close() {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RealtimeAsrBrowserError(`CDP ${pending.method} was interrupted by browser shutdown`));
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
  await cdp.wait(`(() => ({ready:location.pathname==="/health/ready"}))()`, `${account.key} same-origin reset`);
  await cdp.evaluate(`(() => { sessionStorage.clear(); localStorage.clear(); return true; })()`);
  await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)}))()`, `${account.key} sign-in form`);
  requireValue(await cdp.evaluate(valueSetter("#login-name", account.value.loginName)) === true, `${account.key} login input is missing`);
  requireValue(await cdp.evaluate(valueSetter("#login-password", account.value.password)) === true, `${account.key} password input is missing`);
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null}))()`, `${account.key} authenticated workspace`);
}

async function openRealtimeAsr(cdp, account, fixtureBase64) {
  await cdp.wait(`(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>/语音转写|Speech Transcription/.test(item.innerText)); return {ready:Boolean(button&&!button.disabled),found:Boolean(button),disabled:button?.disabled??null}; })()`, `${account.key} ASR catalog card`);
  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>/语音转写|Speech Transcription/.test(item.innerText)); button.click(); return true; })()`);
  await cdp.wait(frame(`(() => ({ready:document.readyState==="complete"&&Boolean(document.querySelector('[data-source="live"]'))&&Boolean(document.querySelector("#live-toggle")),error:document.querySelector("#form-error")?.textContent||null}))()`), `${account.key} ASR iframe`);
  requireValue(await cdp.evaluate(frame(`(() => {
    const view=document.defaultView;
    if(!view.__teamaiboxNativeGetUserMedia){
      view.__teamaiboxNativeGetUserMedia=view.navigator.mediaDevices.getUserMedia.bind(view.navigator.mediaDevices);
      view.navigator.mediaDevices.getUserMedia=async(constraints)=>{
        const permissionStream=await view.__teamaiboxNativeGetUserMedia({...constraints,audio:{...(constraints?.audio||{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
        for(const track of permissionStream.getTracks())track.stop();
        const encoded=${JSON.stringify(fixtureBase64)},bytes=view.Uint8Array.from(view.atob(encoded),(character)=>character.charCodeAt(0));
        const context=new view.AudioContext(),buffer=await context.decodeAudioData(bytes.buffer);
        const destination=context.createMediaStreamDestination(),source=context.createBufferSource();
        source.buffer=buffer;source.loop=true;source.connect(destination);source.start();await context.resume();
        view.__teamaiboxFixtureAudio={context,source,permissionExercised:true};
        return destination.stream;
      };
    }
    if(!view.__teamaiboxNativeWebSocketSend){
      view.__teamaiboxChunkDiagnostics={chunkCount:0,firstChunkBytes:0,firstChunkHeader:null,decodedDuration:null,decodedRms:null,decodeError:null};
      view.__teamaiboxNativeWebSocketSend=view.WebSocket.prototype.send;
      view.WebSocket.prototype.send=function(payload){
        if(payload instanceof view.ArrayBuffer){
          const diagnostics=view.__teamaiboxChunkDiagnostics;
          diagnostics.chunkCount+=1;
          if(diagnostics.firstChunkBytes===0){
            const bytes=new view.Uint8Array(payload);
            diagnostics.firstChunkBytes=bytes.byteLength;
            diagnostics.firstChunkHeader=[...bytes.slice(0,8)].map((item)=>item.toString(16).padStart(2,"0")).join("");
            const context=new view.AudioContext();
            context.decodeAudioData(payload.slice(0)).then((buffer)=>{
              const samples=buffer.getChannelData(0);let sum=0;
              for(let index=0;index<samples.length;index+=1)sum+=samples[index]*samples[index];
              diagnostics.decodedDuration=buffer.duration;
              diagnostics.decodedRms=samples.length?Math.sqrt(sum/samples.length):0;
            }).catch((error)=>{diagnostics.decodeError=String(error?.message||error).slice(0,120)}).finally(()=>context.close());
          }
        }
        return view.__teamaiboxNativeWebSocketSend.call(this,payload);
      };
    }
    document.querySelector('[data-source="live"]').click();
    document.querySelector("#live-language").value="en";
    return !document.querySelector("#live-view").hidden&&!document.querySelector("#live-toggle").disabled;
  })()`)) === true,
    `${account.key} realtime microphone surface is unavailable`);
}

async function completeRealtimeJourney(cdp, account) {
  await cdp.evaluate(frame(`document.querySelector("#live-toggle").click(),true`));
  const active = await cdp.wait(frame(`(() => ({ready:document.querySelector("#live-orb")?.classList.contains("is-active")===true&&document.querySelector("#live-toggle")?.disabled===false,error:document.querySelector("#live-error")?.textContent||null,status:document.querySelector("#live-status")?.textContent||null}))()`), `${account.key} live microphone activation`, 60_000);
  requireValue(!active.error, `${account.key} live microphone activation failed`);
  const completed = await cdp.wait(frame(`(() => { const segments=[...document.querySelectorAll("#live-segments .live-segment p")].map((item)=>item.textContent.trim()).filter(Boolean); return {ready:segments.length>0,error:document.querySelector("#live-error")?.textContent||null,status:document.querySelector("#live-status")?.textContent||null,segmentCount:segments.length,transcriptLength:segments.reduce((sum,item)=>sum+item.length,0),counter:document.querySelector("#live-counter")?.textContent||null,chunkDiagnostics:document.defaultView.__teamaiboxChunkDiagnostics||null}; })()`), `${account.key} real live transcript`, 60_000);
  requireValue(!completed.error && completed.transcriptLength > 0, `${account.key} live transcript is empty`);
  const screenshotState = {
    segmentCount: completed.segmentCount,
    transcriptLength: completed.transcriptLength,
    counter: completed.counter,
    firstChunkBytes: completed.chunkDiagnostics?.firstChunkBytes ?? 0,
    decodedRms: completed.chunkDiagnostics?.decodedRms ?? 0,
  };
  return screenshotState;
}

async function stopRealtimeJourney(cdp, account) {
  await cdp.evaluate(frame(`document.querySelector("#live-toggle").click(),true`));
  const stopped = await cdp.wait(frame(`(() => ({ready:document.querySelector("#live-orb")?.classList.contains("is-active")===false&&document.querySelector("#live-toggle")?.disabled===false&&/尚未启用|not active/.test(document.querySelector("#live-status")?.textContent||""),error:document.querySelector("#live-error")?.textContent||null}))()`), `${account.key} live resource release`, 30_000);
  requireValue(!stopped.error, `${account.key} live resource release reported an error`);
  await cdp.evaluate(frame(`(() => { const fixture=document.defaultView.__teamaiboxFixtureAudio;if(!fixture)return true;try{fixture.source.stop()}catch{}fixture.context.close();document.defaultView.__teamaiboxFixtureAudio=null;return true; })()`));
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(captured.data, "base64");
  requireValue(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "realtime ASR screenshot is invalid");
  const path = join(directory, `${key}.png`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new RealtimeAsrBrowserError("realtime ASR browser evidence exists; use a new run ID"); }).catch((error) => {
    if (error instanceof RealtimeAsrBrowserError) throw error;
    if (error.code !== "ENOENT") throw error;
  });
  const deploymentBytes = await readFile(options.deploymentEvidence);
  const deployment = JSON.parse(deploymentBytes);
  const runtimeBindingBytes = options.runtimeBinding ? await readFile(options.runtimeBinding) : null;
  const runtimeBinding = runtimeBindingBytes ? JSON.parse(runtimeBindingBytes) : null;
  requireValue(runtimeBinding === null || (runtimeBinding.runnerId === "teamaibox.current-realtime-browser-binding.v1"
    && runtimeBinding.status === "passed" && SHA256.test(runtimeBinding.runtime?.web?.imageId ?? "")
    && SHA256.test(runtimeBinding.runtime?.asrPlugin?.imageId ?? "")
    && SHA256.test(runtimeBinding.runtime?.realtimeWorker?.imageId ?? "")),
  "realtime ASR current runtime binding is invalid");
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/);
  requireValue(identity, "realtime ASR deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const web = deployment.imageBindings?.find((item) => item.component === "catalog-web");
  const asr = deployment.imageBindings?.find((item) => item.component === "catalog-asr");
  const worker = deployment.imageBindings?.find((item) => item.component === "realtime-asr-worker");
  requireValue(deployment.status === "passed" && plan.featureKey === "realtime.speech-websocket"
    && plan.featureServices?.includes("asr-plugin") && SHA256.test(web?.imageId ?? "")
    && SHA256.test(asr?.imageId ?? "") && SHA256.test(worker?.imageId ?? ""),
  "realtime ASR browser deployment binding is invalid");
  const fixtureBytes = await readFile(options.audioFixture);
  const fixtureDigest = digest(fixtureBytes);
  let fixtureBase64 = fixtureBytes.toString("base64");
  fixtureBytes.fill(0);
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-realtime-asr-browser-"));
  const port = await freePort();
  const chrome = spawn(options.chrome, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--metrics-recording-only",
    "--ignore-certificate-errors", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${options.audioFixture}`, "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString();
  const journeys = [];
  const consoleErrors = [];
  let cdp;
  let browser = null;
  let failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page");
    requireValue(target?.webSocketDebuggerUrl, "Chrome page target is unavailable");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => {
      const values = (event.args ?? []).map((item) => item.value);
      if (event.type === "error") consoleErrors.push(String(values[0] ?? "console error").slice(0, 300));
    });
    await Promise.all([
      cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"),
      cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }),
    ]);
    browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);
    for (const account of accounts) {
      await signIn(cdp, options.origin, account);
      await openRealtimeAsr(cdp, account, fixtureBase64);
      const result = await completeRealtimeJourney(cdp, account);
      requireValue(result.firstChunkBytes >= 44 && result.decodedRms > 0.001,
        `${account.key} encoded microphone fixture was silent or empty`);
      const shot = await screenshot(cdp, options.screenshots, account.key);
      await stopRealtimeJourney(cdp, account);
      journeys.push({ key: account.key, role: account.role, launchable: true, liveSurfaceVisible: true,
        microphonePermissionExercised: true, fixtureMicrophoneInjected: true, websocketConnected: true, transcriptCompleted: true,
        segmentCount: result.segmentCount, transcriptLength: result.transcriptLength,
        firstChunkBytes: result.firstChunkBytes, decodedRms: result.decodedRms,
        stoppedAndReleased: true, screenshot: shot });
    }
    requireValue(consoleErrors.length === 0, `realtime ASR browser emitted ${consoleErrors.length} error events`);
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]);
    await rm(profile, { recursive: true, force: true });
    fixtureBase64 = "[REDACTED]";
    for (const account of accounts) account.value.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 1,
    runnerId: "teamaibox.realtime-asr-browser-smoke.v1",
    runId: options.runId,
    featureKey: "realtime.speech-websocket",
    status: failure ? "failed" : "passed",
    classification: "component-canary-self-signed-https",
    releaseEvidenceEligible: false,
    origin: options.origin,
    startedAt,
    completedAt: new Date().toISOString(),
    browser,
    journeys,
    console: { errorCount: consoleErrors.length },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), audioFixtureDigest: fixtureDigest },
    deployment: {
      evidencePath: relative(ROOT, options.deploymentEvidence),
      evidenceDigest: digest(deploymentBytes),
      runId: deployment.runId,
      webImageId: web.imageId,
      asrImageId: asr.imageId,
      workerImageId: worker.imageId,
    },
    ...(runtimeBinding === null ? {} : { runtimeBinding: {
      evidencePath: relative(ROOT, options.runtimeBinding),
      evidenceDigest: digest(runtimeBindingBytes),
      runId: runtimeBinding.runId,
      webImageId: runtimeBinding.runtime.web.imageId,
      asrImageId: runtimeBinding.runtime.asrPlugin.imageId,
      workerImageId: runtimeBinding.runtime.realtimeWorker.imageId,
    } }),
    privacy: {
      credentialsRetained: false,
      userContentRetained: false,
      syntheticTranscriptScreenshotRetained: true,
      commandOutputRetained: false,
      syntheticContentOnly: true,
      microphoneFixtureOnly: true,
    },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new RealtimeAsrBrowserError(`realtime ASR browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, journeyCount: journeys.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? "realtime ASR browser smoke failed"}\n`);
  process.exitCode = 1;
});
