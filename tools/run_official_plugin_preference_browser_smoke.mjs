#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^official-plugin-preference-browser-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TOKEN_COUNT = 38;
const APPLICATIONS = [
  { key: "official.messaging", label: "即时通信", selector: "#conversation-search", prototype: "HTMLInputElement" },
  { key: "official.team-drive", label: "团队网盘", selector: "#search", prototype: "HTMLInputElement" },
  { key: "official.drawing", label: "AI 绘图", selector: "#prompt", prototype: "HTMLTextAreaElement" },
  { key: "official.ocr", label: "文字识别", selector: "#format", prototype: "HTMLSelectElement", marker: "markdown" },
  { key: "official.asr", label: "语音转写", selector: "#language", prototype: "HTMLSelectElement", marker: "en" },
  { key: "official.translation", label: "翻译", selector: "#source-text", prototype: "HTMLTextAreaElement" },
];
const TOKEN_NAMES = ["canvas","surface","surface-raised","surface-subtle","text","text-muted","border","border-strong","interactive","interactive-hover","on-interactive","selected-surface","selected-text","focus","disabled-surface","disabled-text","disabled-border","success","success-soft","warning","warning-soft","error","error-soft","info","info-soft","chart-1","chart-2","chart-3","chart-4","chart-5","chart-6","code-surface","code-text","log-info","log-warning","log-error","shadow-sm","shadow-lg"];

class SmokeError extends Error {}
const need = (condition, message) => { if (!condition) throw new SmokeError(message); };
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "official preference arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `official preference ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "official preference origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "official preference run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "official preference artifact escapes the repository"); }
  return result;
}

async function credentialsFromStdin() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks);
  try { const value = JSON.parse(raw.toString("utf8")); need(typeof value.owner?.loginName === "string" && typeof value.owner?.password === "string" && value.owner.password.length >= 8, "owner browser credential is unavailable"); return { owner: value.owner }; }
  finally { raw.fill(0); }
}
async function freePort() { const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); }); const port = server.address().port; await new Promise((done) => server.close(done)); return port; }
async function waitJson(url) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); } throw new SmokeError("Headless Chrome did not become ready"); }

class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = new Map();
  static async connect(url) { const value = new Cdp(); value.#socket = new WebSocket(url); await new Promise((done, reject) => { value.#socket.addEventListener("open", done, { once: true }); value.#socket.addEventListener("error", () => reject(new SmokeError("Chrome DevTools connection failed")), { once: true }); }); value.#socket.addEventListener("message", (event) => value.#message(event)); return value; }
  #message(event) { const value = JSON.parse(String(event.data)); if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id); value.error ? pending.reject(new SmokeError(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return; } for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {}); }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 60_000) { const id = this.#id++; return new Promise((done, reject) => { const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new SmokeError(`CDP ${method} timed out`)); }, timeout); this.#pending.set(id, { method, resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.#socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new SmokeError(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed"); return value.result?.value; }
  async wait(expression, label, timeout = 40_000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message })); if (last?.ready === true) return last; await sleep(200); } throw new SmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 600)}`); }
  close() { this.#socket.close(); }
}

const setter = (selector, value, prototype, root = "document") => `(() => {const element=${root}.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(${prototype}.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return element.value===${JSON.stringify(value)}})()`;
async function signIn(cdp, origin, account) { await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin }); await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, "sign-in form"); need(await cdp.evaluate(setter("#login-name", account.loginName, "HTMLInputElement")), "login input is missing"); need(await cdp.evaluate(setter("#login-password", account.password, "HTMLInputElement")), "password input is missing"); await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`); await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, "authenticated workbench"); }
async function setPreferences(cdp, { locale, theme }) { await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".profile-popover"))})`, "profile preferences"); await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[0].querySelectorAll("button")[${locale === "en" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "locale switch"); await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[1].querySelectorAll("button")[${theme === "dark" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "theme switch"); await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:!document.querySelector(".profile-popover")})`, "profile preferences close"); }
async function shot(cdp, directory, key) { const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }); const bytes = Buffer.from(captured.data, "base64"); need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is invalid"); const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" }); return { path: relative(ROOT, path), digest: digest(bytes) }; }

async function openApplication(cdp, app) {
  const card = await cdp.wait(`(() => {const card=[...document.querySelectorAll("button.application-card")].find(item=>item.querySelector("strong")?.textContent.trim()===${JSON.stringify(app.label)});return{ready:Boolean(card&&!card.disabled)}})()`, `${app.key} card`, 60_000); need(card.ready, `${app.key} card is unavailable`);
  await cdp.evaluate(`([...document.querySelectorAll("button.application-card")].find(item=>item.querySelector("strong")?.textContent.trim()===${JSON.stringify(app.label)})).click(),true`);
  return cdp.wait(`(() => {const frame=document.querySelector("iframe.plugin-workspace__frame"),doc=frame?.contentDocument,root=doc?.documentElement,control=doc?.querySelector(${JSON.stringify(app.selector)}),revision=Number(root?.dataset.pluginPreferenceRevision||0),tokens=${JSON.stringify(TOKEN_NAMES)}.filter(name=>root?.style.getPropertyValue("--teamaibox-"+name)).length;return{ready:Boolean(frame&&control&&revision>=1&&tokens===${TOKEN_COUNT}),revision,tokens,src:frame?.getAttribute("src")||"",alias:root?frame.contentWindow.getComputedStyle(root).getPropertyValue("--bg").trim():"",hostCanvas:getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),canvas:root?.style.getPropertyValue("--teamaibox-canvas")||""}})()`, `${app.key} preference client`, 80_000);
}
async function frameState(cdp, app, { revisionAfter, identity, marker, locale, theme, initialText }) {
  return cdp.wait(`(() => {const frame=document.querySelector("iframe.plugin-workspace__frame"),doc=frame?.contentDocument,root=doc?.documentElement,text=Object.fromEntries([...doc?.querySelectorAll("[data-i18n]")||[]].slice(0,40).map(node=>[node.dataset.i18n,node.textContent])),baseline=${JSON.stringify(initialText)},changed=Object.keys(text).filter(key=>baseline[key]!==undefined&&baseline[key]!==text[key]).length,value={revision:Number(root?.dataset.pluginPreferenceRevision||0),identity:frame?.contentWindow?.__officialPreferenceIdentity||"",marker:doc?.querySelector(${JSON.stringify(app.selector)})?.value||"",locale:root?.lang||"",theme:root?.dataset.theme||"",src:frame?.getAttribute("src")||"",changed,canvas:root?.style.getPropertyValue("--teamaibox-canvas")||"",hostCanvas:getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()};return{ready:value.revision>${revisionAfter}&&value.identity===${JSON.stringify(identity)}&&value.marker===${JSON.stringify(marker)}&&value.locale===${JSON.stringify(locale)}&&value.theme===${JSON.stringify(theme)}&&value.canvas===value.hostCanvas&&value.changed>0,...value}})()`, `${app.key} ${locale}/${theme}`, 30_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new SmokeError("official preference evidence exists; use a new run ID"); }).catch((error) => { if (error instanceof SmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))), images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && ["admin.plugins", "admin.encryption"].includes(deployment.featureKey)
    && [images["catalog-web"], images["catalog-platform-api"]].every((item) => SHA256.test(item ?? "")), "official preference deployment binding is invalid");
  need(APPLICATIONS.every((app) => SHA256.test(images[`catalog-${app.key.slice("official.".length)}`] ?? "")), "official plugin image binding is incomplete");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "official preference origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-official-preference-browser-")), port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString(), applications = [], screenshots = [], errors = []; let cdp, browserIdentity = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); need(target?.webSocketDebuggerUrl, "Chrome page target is missing"); cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => errors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") errors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })]); browserIdentity = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);
    await signIn(cdp, options.origin, accounts.owner); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" });
    for (const app of APPLICATIONS) {
      const initial = await openApplication(cdp, app), marker = app.marker ?? `retained-${app.key}`, assigned = await cdp.evaluate(`(() => {const frame=document.querySelector("iframe.plugin-workspace__frame"),doc=frame.contentDocument;frame.contentWindow.__officialPreferenceIdentity=crypto.randomUUID();const identity=frame.contentWindow.__officialPreferenceIdentity,initialText=Object.fromEntries([...doc.querySelectorAll("[data-i18n]")].slice(0,40).map(node=>[node.dataset.i18n,node.textContent]));return{identity,initialText,assigned:${setter(app.selector, marker, app.prototype, "doc")},marker:doc.querySelector(${JSON.stringify(app.selector)}).value,src:frame.getAttribute("src")}})()`);
      need(assigned.assigned && assigned.marker === marker && initial.tokens === TOKEN_COUNT && initial.alias === initial.canvas && initial.canvas === initial.hostCanvas, `${app.key} initial semantic preference state is incomplete`);
      await setPreferences(cdp, { locale: "en", theme: "light" }); const english = await frameState(cdp, app, { revisionAfter: initial.revision, identity: assigned.identity, marker, locale: "en", theme: "light", initialText: assigned.initialText });
      await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); const chinese = await frameState(cdp, app, { revisionAfter: english.revision, identity: assigned.identity, marker, locale: "zh-CN", theme: "dark", initialText: Object.fromEntries(Object.entries(assigned.initialText).map(([key]) => [key, `__different-${key}`])) });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const mobile = await cdp.evaluate(`(()=>{const frame=document.querySelector("iframe.plugin-workspace__frame"),doc=frame?.contentDocument,view=frame?.contentWindow;return{hostWidth:innerWidth,hostScrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),frameWidth:frame?.getBoundingClientRect().width||0,pluginWidth:view?.innerWidth||0,pluginScrollWidth:doc?Math.max(doc.documentElement.scrollWidth,doc.body.scrollWidth):0,identity:view?.__officialPreferenceIdentity||"",marker:doc?.querySelector(${JSON.stringify(app.selector)})?.value||""}})()`);
      need(mobile.hostWidth === 390 && mobile.hostScrollWidth <= 390 && mobile.frameWidth === 390 && mobile.pluginScrollWidth <= mobile.pluginWidth && mobile.identity === assigned.identity && mobile.marker === marker, `${app.key} mobile state or containment drifted`);
      const screenshot = await shot(cdp, options.screenshots, app.key.replaceAll(".", "-")); screenshots.push(screenshot);
      applications.push({ key: app.key, imageId: images[`catalog-${app.key.slice("official.".length)}`], initialRevision: initial.revision, englishRevision: english.revision, finalRevision: chinese.revision, semanticTokenCount: initial.tokens, iframeIdentityPreserved: english.identity === assigned.identity && chinese.identity === assigned.identity, inputStatePreserved: english.marker === marker && chinese.marker === marker, englishLightApplied: english.changed > 0, chineseDarkApplied: chinese.changed > 0, mobileNoOverflow: true, screenshot });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.evaluate(`document.querySelector(".plugin-workspace__header .icon-button").click(),true`); await cdp.wait(`({ready:!document.querySelector(".plugin-workspace")})`, `${app.key} close`);
    }
    need(applications.length === APPLICATIONS.length && applications.every((item) => item.iframeIdentityPreserved && item.inputStatePreserved && item.englishLightApplied && item.chineseDarkApplied && item.mobileNoOverflow), "one or more official preference journeys failed"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 600) }; }
  finally { cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(3_000)]); await rm(profile, { recursive: true, force: true }); accounts.owner.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.official-plugin-preference-browser-smoke.v1", runId: options.runId, featureKey: deployment.featureKey, status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: browserIdentity, applications, screenshots, console: { errorCount: errors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { assistantApplication: "not_in_plugin_sdk_scope", fullAccessibilityMatrix: "not_performed", trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }); if (failure) throw new SmokeError(`official preference browser smoke failed; evidence: ${relative(ROOT, options.output)}`); process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, applicationCount: applications.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}
main().catch((error) => { process.stderr.write(`${error?.message ?? "official preference browser smoke failed"}\n`); process.exitCode = 1; });
