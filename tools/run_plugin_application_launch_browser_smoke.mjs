#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^plugin-application-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATIONS = [
  "ownerCatalogLaunchable", "ownerRealContent", "ownerCompatibilityVisible", "ownerNegotiatedRoute",
  "ownerReloadRetained", "chineseDarkApplied", "memberCatalogLaunchable", "memberRealContent",
  "englishLightApplied", "mobileNoOverflow", "anonymousPluginDenied", "privateOriginHidden",
];

class SmokeError extends Error {}
const need = (condition, message) => { if (!condition) throw new SmokeError(message); };
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Application browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Application browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Application browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Application browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Application browser artifact escapes the repository");
  }
  return result;
}

async function credentialsFromStdin() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    for (const key of ["owner", "member"]) need(typeof value[key]?.loginName === "string" && typeof value[key]?.password === "string" && value[key].password.length >= 8, `${key} browser credential is unavailable`);
    return { owner: value.owner, member: value.member };
  } finally { raw.fill(0); }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function waitJson(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); }
  throw new SmokeError("Headless Chrome did not become ready");
}

class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const value = new Cdp(); value.#socket = new WebSocket(url);
    await new Promise((done, reject) => { value.#socket.addEventListener("open", done, { once: true }); value.#socket.addEventListener("error", () => reject(new SmokeError("Chrome DevTools connection failed")), { once: true }); });
    value.#socket.addEventListener("message", (event) => value.#message(event)); return value;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id); value.error ? pending.reject(new SmokeError(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return; }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 60_000) {
    const id = this.#id++;
    return new Promise((done, reject) => { const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new SmokeError(`CDP ${method} timed out`)); }, timeout); this.#pending.set(id, { method, resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.#socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new SmokeError(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed"); return value.result?.value; }
  async wait(expression, label, timeout = 40_000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message })); if (last?.ready === true) return last; await sleep(200); } throw new SmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 500)}`); }
  close() { this.#socket.close(); }
}

const setter = (selector, value, prototype = "HTMLInputElement") => `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(${prototype}.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;
async function signIn(cdp, origin, account) {
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, "sign-in form");
  need(await cdp.evaluate(setter("#login-name", account.loginName)), "login input is missing"); need(await cdp.evaluate(setter("#login-password", account.password)), "password input is missing");
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`); await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, "authenticated workbench");
}
async function setPreferences(cdp, { locale, theme }) {
  await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".profile-popover"))})`, "profile preferences");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[0].querySelectorAll("button")[${locale === "en" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "locale switch");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[1].querySelectorAll("button")[${theme === "dark" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "theme switch");
  await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:!document.querySelector(".profile-popover")})`, "profile preferences close");
}
async function openApplication(cdp, origin) {
  await cdp.send("Page.navigate", { url: origin });
  const card = await cdp.wait(`(() => {const card=[...document.querySelectorAll("button.application-card")].find((item)=>/example\.team-notes/.test(item.innerText));return{ready:Boolean(card&&!card.disabled),catalogState:document.querySelector(".application-catalog-state")?.innerText||"",labels:[...document.querySelectorAll("button.application-card strong")].map((item)=>item.innerText)}})()`, "Team Notes application card", 60_000);
  need(card.ready === true, "Team Notes application card is unavailable");
  await cdp.evaluate(`([...document.querySelectorAll("button.application-card")].find((item)=>/example\.team-notes/.test(item.innerText))).click(),true`);
  return cdp.wait(`(() => {const frame=document.querySelector("iframe.plugin-workspace__frame"),body=frame?.contentDocument?.body?.innerText||"";return{ready:/Team Notes sample/.test(body)&&/Version\\s+2\.0\.0/.test(body),body,src:frame?.getAttribute("src")||"",header:document.querySelector(".plugin-workspace__header")?.innerText||"",notice:document.querySelector(".plugin-workspace__compatibility")?.innerText||"",launchable:Boolean(frame)}})()`, "real Team Notes application", 80_000);
}
async function shot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }); const bytes = Buffer.from(captured.data, "base64");
  need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is invalid");
  const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" }); return { key, path: relative(ROOT, path), digest: digest(bytes) };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new SmokeError("Application browser evidence exists; use a new run ID"); }).catch((error) => { if (error instanceof SmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))), images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.plugins" && [images["catalog-web"], images["catalog-platform-api"]].every((item) => SHA256.test(item ?? "")), "Application deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Application browser origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-plugin-application-browser-")), port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATIONS.map((key) => [key, false])), screenshots = [], errors = [];
  let cdp, browserIdentity = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); need(target?.webSocketDebuggerUrl, "Chrome page target is missing"); cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => errors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") errors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })]); browserIdentity = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    await signIn(cdp, options.origin, accounts.owner); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const ownerCatalog = await cdp.evaluate(String.raw`(async()=>{
      const response=await fetch("/api/v1/applications",{credentials:"same-origin",headers:{accept:"application/json"}});
      const text=await response.text(),value=JSON.parse(text),app=value.applications.find((item)=>item.pluginKey==="example.team-notes");
      const privateOrigin=/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b|workerOrigin|containerOrigin/.test(text);
      return{status:response.status,launchable:app?.launchable===true,privateOrigin};
    })()`);
    operations.ownerCatalogLaunchable = ownerCatalog.status === 200 && ownerCatalog.launchable; operations.privateOriginHidden = ownerCatalog.privateOrigin === false;
    const owner = await openApplication(cdp, options.origin); operations.ownerRealContent = owner.ready === true; operations.ownerCompatibilityVisible = /打开前的兼容性提示/.test(owner.notice) && /en/.test(owner.notice); operations.ownerNegotiatedRoute = /[?&]locale=en(?:&|$)/.test(owner.src) && /[?&]theme=dark(?:&|$)/.test(owner.src); need(operations.ownerCatalogLaunchable && operations.privateOriginHidden && operations.ownerRealContent && operations.ownerCompatibilityVisible && operations.ownerNegotiatedRoute, "owner real application launch or compatibility contract drifted"); screenshots.push(await shot(cdp, options.screenshots, "owner-team-notes-zh-dark"));
    await cdp.send("Page.reload", { ignoreCache: false }); const retained = await cdp.wait(`(() => {const frame=document.querySelector("iframe.plugin-workspace__frame"),body=frame?.contentDocument?.body?.innerText||"";return{ready:/Team Notes sample/.test(body)&&/Version\\s+2\.0\.0/.test(body)&&Boolean(document.querySelector(".plugin-workspace__compatibility")),path:location.pathname,login:Boolean(document.querySelector("#login-name")),appFrame:Boolean(document.querySelector(".app-frame")),catalogState:document.querySelector(".application-catalog-state")?.innerText||"",cards:[...document.querySelectorAll("button.application-card strong")].map((item)=>item.innerText),dialog:Boolean(document.querySelector(".plugin-workspace")),frame:Boolean(frame)}})()`, "application after browser reload", 20_000); operations.ownerReloadRetained = retained.ready === true;

    await signIn(cdp, options.origin, accounts.member); await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); const member = await openApplication(cdp, options.origin); operations.memberCatalogLaunchable = member.launchable === true; operations.memberRealContent = member.ready === true && member.notice === "" && /[?&]locale=en(?:&|$)/.test(member.src) && /[?&]theme=light(?:&|$)/.test(member.src);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),frameWidth:document.querySelector("iframe.plugin-workspace__frame")?.getBoundingClientRect().width||0,locale:document.documentElement.lang,theme:document.documentElement.dataset.theme})`); operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.frameWidth === 390 && mobile.locale === "en" && mobile.theme === "light"; need(operations.memberCatalogLaunchable && operations.memberRealContent && operations.mobileNoOverflow, "member or mobile real application launch drifted"); screenshots.push(await shot(cdp, options.screenshots, "member-team-notes-en-light-mobile"));

    await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: options.origin }); await cdp.wait(`({ready:Boolean(document.querySelector("#login-name"))})`, "anonymous sign-in page"); const anonymous = await cdp.evaluate(`fetch("/plugins/example.team-notes",{credentials:"same-origin"}).then(async(response)=>({status:response.status,body:(await response.text()).slice(0,200)}))`); operations.anonymousPluginDenied = anonymous.status === 404 && !/Team Notes sample/.test(anonymous.body);
    need(OPERATIONS.every((key) => operations[key] === true), "one or more application browser operations did not pass"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) }; }
  finally { cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(3_000)]); await rm(profile, { recursive: true, force: true }); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.plugin-application-browser-smoke.v1", runId: options.runId, featureKey: "admin.plugins", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: browserIdentity, operations, screenshots, console: { errorCount: errors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new SmokeError(`Application browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATIONS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Application browser smoke failed"}\n`); process.exitCode = 1; });
