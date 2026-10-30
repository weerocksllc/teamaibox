#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^admin-plugins-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  "verifiedInventoryVisible", "applicationAndComputeVisible", "sourceRoutesVisible", "disablePassed", "enablePassed",
  "failedUpgradeRolledBack", "reloadRetained", "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow",
  "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied",
];

class BrowserSmokeError extends Error {}
const need = (condition, message) => { if (!condition) throw new BrowserSmokeError(message); };
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Plugins browser arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Plugins browser ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Plugins browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Plugins browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Plugins browser artifact escapes the repository"); }
  return result;
}

async function credentialsFromStdin() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks);
  try { const value = JSON.parse(raw.toString("utf8")); for (const key of ["owner", "member"]) need(typeof value[key]?.loginName === "string" && typeof value[key]?.password === "string" && value[key].password.length >= 8, `${key} browser credential is unavailable`); return { owner: value.owner, member: value.member }; }
  finally { raw.fill(0); }
}

async function freePort() { const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); }); const port = server.address().port; await new Promise((done) => server.close(done)); return port; }
async function waitJson(url) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); } throw new BrowserSmokeError("Headless Chrome did not become ready"); }

class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = new Map();
  static async connect(url) { const value = new Cdp(); value.#socket = new WebSocket(url); await new Promise((done, reject) => { value.#socket.addEventListener("open", done, { once: true }); value.#socket.addEventListener("error", () => reject(new BrowserSmokeError("Chrome DevTools connection failed")), { once: true }); }); value.#socket.addEventListener("message", (event) => value.#message(event)); return value; }
  #message(event) { const value = JSON.parse(String(event.data)); if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id); value.error ? pending.reject(new BrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return; } for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {}); }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 60_000) { const id = this.#id++; return new Promise((done, reject) => { const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new BrowserSmokeError(`CDP ${method} timed out`)); }, timeout); this.#pending.set(id, { method, resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.#socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new BrowserSmokeError(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed"); return value.result?.value; }
  async wait(expression, label, timeout = 30_000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message })); if (last?.ready === true) return last; await sleep(200); } throw new BrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 400)}`); }
  close() { this.#socket.close(); }
}

const setter = (selector, value, prototype = "HTMLInputElement") => `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(${prototype}.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;
async function signIn(cdp, origin, account) { await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin }); await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, "sign-in form"); need(await cdp.evaluate(setter("#login-name", account.loginName)), "login input is missing"); need(await cdp.evaluate(setter("#login-password", account.password)), "password input is missing"); await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`); await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, "authenticated workbench"); }
async function openPlugins(cdp, origin) { await cdp.send("Page.navigate", { url: new URL("/admin/plugins", origin).href }); return cdp.wait(`({ready:Boolean(document.querySelector(".plugin-admin .plugin-inventory")),error:document.querySelector(".plugin-admin__error")?.textContent||null})`, "Plugins administration", 40_000); }
async function setPreferences(cdp, { locale, theme }) { await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".profile-popover"))})`, "profile preferences"); await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[0].querySelectorAll("button")[${locale === "en" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "locale switch"); await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[1].querySelectorAll("button")[${theme === "dark" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "theme switch"); await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); return cdp.wait(`({ready:!document.querySelector(".profile-popover")})`, "profile preferences close"); }
async function clickPluginButton(cdp, pluginId, pattern) { return cdp.evaluate(`(() => {const card=document.querySelector('[data-plugin-id=${JSON.stringify(pluginId)}]'),button=[...(card?.querySelectorAll("footer button")??[])].find((item)=>${pattern}.test(item.textContent||""));if(!button)return false;button.click();return true})()`); }
async function shotElement(cdp, directory, key, selector) { const box = await cdp.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)}),rect=element?.getBoundingClientRect();return rect?{x:rect.x+scrollX,y:rect.y+scrollY,width:rect.width,height:rect.height}:null})()`); need(box && box.width > 0 && box.height > 0 && box.width <= 2000 && box.height <= 2400, `${key} screenshot element is invalid`); const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { ...box, scale: 1 } }); const bytes = Buffer.from(captured.data, "base64"); need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is invalid"); const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" }); return { key, path: relative(ROOT, path), digest: digest(bytes) }; }

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new BrowserSmokeError("Admin Plugins browser evidence exists; use a new run ID"); }).catch((error) => { if (error instanceof BrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))), images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.plugins" && [images["catalog-web"], images["catalog-platform-api"]].every((item) => SHA256.test(item ?? "")), "Admin Plugins deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Plugins origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-admin-plugins-browser-")), port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [], errors = [];
  let cdp, browser = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); need(target?.webSocketDebuggerUrl, "Chrome page target is missing"); cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => errors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300))); cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") errors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })]); browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    await signIn(cdp, options.origin, accounts.owner); await openPlugins(cdp, options.origin); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const inventory = await cdp.evaluate(`(() => {const summary=[...document.querySelectorAll(".plugin-admin__summary article")].map((item)=>({count:Number(item.querySelector("strong")?.textContent),text:item.textContent})),team=document.querySelector('[data-plugin-id="example.team-notes"]'),compute=document.querySelector('[data-plugin-id="example.text-transform"]');return{summary,team:Boolean(team),compute:Boolean(compute),teamText:team?.innerText||"",computeText:compute?.innerText||""}})()`);
    operations.verifiedInventoryVisible = inventory.summary[0]?.count === 4 && inventory.team && /2\.0\.0/.test(inventory.teamText);
    operations.applicationAndComputeVisible = inventory.summary[2]?.count === 3 && inventory.summary[3]?.count === 1 && inventory.compute && /1\.0\.0/.test(inventory.computeText);
    need(operations.verifiedInventoryVisible && operations.applicationAndComputeVisible, "verified plugin inventory drifted"); screenshots.push(await shotElement(cdp, options.screenshots, "owner-inventory-zh-dark", ".plugin-admin"));

    await cdp.evaluate(`document.querySelector(".plugin-admin__header .primary-button").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".plugin-import select"))})`, "plugin import composer");
    const sourceFields = [];
    for (const [kind, selector] of [["marketplace", 'input[name="pluginId"]'], ["private-registry", 'input[name="reference"]'], ["offline-bundle", 'input[name="expectedBundleDigest"]']]) { need(await cdp.evaluate(setter(".plugin-import select", kind, "HTMLSelectElement")), `plugin source ${kind} is missing`); const result = await cdp.wait(`({ready:Boolean(document.querySelector(${JSON.stringify(selector)}))})`, `plugin source ${kind}`); sourceFields.push(result.ready); }
    operations.sourceRoutesVisible = sourceFields.every(Boolean); need(operations.sourceRoutesVisible, "one or more plugin import routes are missing"); screenshots.push(await shotElement(cdp, options.screenshots, "owner-import-sources-zh-dark", ".plugin-import")); await cdp.evaluate(`document.querySelector(".plugin-admin__header .primary-button").click(),true`);

    need(await clickPluginButton(cdp, "example.team-notes", "/停用|Disable/i"), "team-notes disable action is missing"); await cdp.wait(`({ready:document.querySelector('[data-plugin-id="example.team-notes"]')?.classList.contains("plugin-card--disabled")===true})`, "team-notes disable", 40_000); operations.disablePassed = true;
    need(await clickPluginButton(cdp, "example.team-notes", "/启用|Enable/i"), "team-notes enable action is missing"); const enabled = await cdp.wait(`(() => {const card=document.querySelector('[data-plugin-id="example.team-notes"]');return{ready:card?.classList.contains("plugin-card--enabled")===true&&/2\.0\.0/.test(card.innerText)&&/green|绿色/i.test(card.innerText)}})()`, "team-notes enable", 80_000); operations.enablePassed = enabled.ready === true;
    need(await clickPluginButton(cdp, "example.team-notes", "/3\\.0\\.0/"), "team-notes failing upgrade action is missing"); const rollback = await cdp.wait(`(() => {const card=document.querySelector('[data-plugin-id="example.team-notes"]'),code=document.querySelector(".plugin-admin__error code")?.textContent||"";return{ready:code==="plugin_health_failed"&&card?.classList.contains("plugin-card--enabled")===true&&/2\.0\.0/.test(card.innerText)&&/green|绿色/i.test(card.innerText),code}})()`, "failed upgrade rollback", 150_000); operations.failedUpgradeRolledBack = rollback.ready === true; need(operations.enablePassed && operations.failedUpgradeRolledBack, "plugin enable or failed-upgrade rollback drifted"); screenshots.push(await shotElement(cdp, options.screenshots, "owner-failed-upgrade-zh-dark", '[data-plugin-id="example.team-notes"]'));

    await cdp.send("Page.reload", { ignoreCache: false }); await openPlugins(cdp, options.origin); const retained = await cdp.evaluate(`(() => {const card=document.querySelector('[data-plugin-id="example.team-notes"]');return Boolean(card?.classList.contains("plugin-card--enabled")&&/2\.0\.0/.test(card.innerText)&&/green|绿色/i.test(card.innerText))})()`); operations.reloadRetained = retained === true; need(operations.reloadRetained, "plugin state was not retained after browser reload");
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true; screenshots.push(await shotElement(cdp, options.screenshots, "owner-desktop-en-light", ".plugin-admin__summary"));

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openPlugins(cdp, options.origin); const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,team:Boolean(document.querySelector('[data-plugin-id="example.team-notes"]'))})`); operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.team; need(operations.mobileNoOverflow, "mobile Plugins layout overflowed or lost inventory/preferences"); screenshots.push(await shotElement(cdp, options.screenshots, "owner-mobile-en-light", '[data-plugin-id="example.team-notes"]'));

    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/plugins", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member direct route denial"); const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/plugins",{credentials:"same-origin",headers:{accept:"application/json"}}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{adminNav:[...document.querySelectorAll(".nav-item")].some((item)=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".plugin-admin")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page),status:response.status}})()`);
    operations.memberAdminHidden = denied.adminNav === false; operations.memberApiDenied = denied.status === 403; operations.memberDirectRouteDenied = denied.panel === false && denied.denial === true && denied.ownerClaim === false && denied.memberClaim === true; need(operations.memberAdminHidden && operations.memberApiDenied && operations.memberDirectRouteDenied, "ordinary member gained Plugins access or misleading identity");
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Plugins browser operations did not pass"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(3_000)]); await rm(profile, { recursive: true, force: true }); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-plugins-browser-smoke.v1", runId: options.runId, featureKey: "admin.plugins", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser, operations, screenshots, console: { errorCount: errors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }); if (failure) throw new BrowserSmokeError(`Admin Plugins browser smoke failed; evidence: ${relative(ROOT, options.output)}`); process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}
main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Plugins browser smoke failed"}\n`); process.exitCode = 1; });
