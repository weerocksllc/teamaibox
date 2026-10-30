#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readSmokeAccounts, clearSmokeAccounts, temporarySmokeAccount, temporaryAccountLifecycle, cleanupFailure } from "./admin-smoke-accounts.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^admin-users-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  "unfinishedDomainsDisabled", "selfDisableGuarded", "memberCreated",
  "duplicateConflictLocalized", "memberDisabled", "sessionRevoked", "disabledLoginDenied",
  "memberEnabled", "passwordReset", "oldPasswordDenied", "replacementLoginSucceeded",
  "reloadRetained", "auditEventsVisible", "auditChainVerified", "englishLightApplied",
  "chineseDarkApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied",
];

class BrowserSmokeError extends Error {}
const need = (condition, message) => { if (!condition) throw new BrowserSmokeError(message); };
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Users browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Users browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Users browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Users browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Users browser artifact escapes the repository");
  }
  return result;
}

const credentialsFromStdin = () => readSmokeAccounts(process.stdin, { targetRequired: false });

async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function waitJson(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); }
  throw new BrowserSmokeError("Headless Chrome did not become ready");
}

class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = new Map();
  static async connect(url) { const value = new Cdp(); value.#socket = new WebSocket(url); await new Promise((done, reject) => { value.#socket.addEventListener("open", done, { once: true }); value.#socket.addEventListener("error", () => reject(new BrowserSmokeError("Chrome DevTools connection failed")), { once: true }); }); value.#socket.addEventListener("message", (event) => value.#message(event)); return value; }
  #message(event) { const value = JSON.parse(String(event.data)); if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id); value.error ? pending.reject(new BrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return; } for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {}); }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 60_000) { const id = this.#id++; return new Promise((done, reject) => { const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new BrowserSmokeError(`CDP ${method} timed out`)); }, timeout); this.#pending.set(id, { method, resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.#socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression, { byValue = true } = {}) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: byValue, userGesture: true }); if (value.exceptionDetails) throw new BrowserSmokeError(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed"); return byValue ? value.result?.value : value.result; }
  async wait(expression, label, timeout = 30_000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message })); if (last?.ready === true) return last; await sleep(200); } throw new BrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 300)}`); }
  close() { this.#socket.close(); }
}

const setter = (selector, value) => `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;
async function signIn(cdp, origin, account) {
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, "sign-in form");
  need(await cdp.evaluate(setter("#login-name", account.loginName)), "login input is missing"); need(await cdp.evaluate(setter("#login-password", account.password)), "password input is missing");
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`); await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, "authenticated workbench");
}
async function openUsers(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/users", origin).href });
  return cdp.wait(`(() => ({ready:Boolean(document.querySelector(".identity-admin__table")),error:document.querySelector(".identity-admin__state--error")?.textContent||null}))()`, "Users administration", 40_000);
}
async function setPreferences(cdp, { locale, theme }) {
  await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".profile-popover"))})`, "profile preferences");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[0].querySelectorAll("button")[${locale === "en" ? 1 : 0}].click(),true`);
  await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "locale switch");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[1].querySelectorAll("button")[${theme === "dark" ? 1 : 0}].click(),true`);
  return cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "theme switch");
}
async function createMember(cdp, loginName, displayName, password) {
  need(await cdp.evaluate(`(() => {const button=[...document.querySelectorAll(".identity-admin__header button")].find((item)=>/创建成员|Create member/.test(item.textContent));button?.click();return Boolean(button)})()`), "create-member control is missing");
  await cdp.wait(`({ready:Boolean(document.querySelector(".identity-composer"))})`, "member composer");
  for (const [name, value] of [["loginName", loginName], ["displayName", displayName], ["password", password]]) need(await cdp.evaluate(setter(`.identity-composer input[name="${name}"]`, value)), `${name} input is missing`);
  await cdp.evaluate(`document.querySelector(".identity-composer").requestSubmit()`);
}
async function rowState(cdp, loginName, status, label) { return cdp.wait(`(() => {const row=document.querySelector(${JSON.stringify(`tr[data-identity-login="${loginName}"]`)});return{ready:Boolean(row&&row.querySelector(".identity-status")?.classList.contains(${JSON.stringify(`identity-status--${status}`)})),text:row?.innerText||null}})()`, label, 40_000); }
async function action(cdp, loginName, pattern, kind, password = null) {
  const clicked = await cdp.evaluate(`(() => {const row=document.querySelector(${JSON.stringify(`tr[data-identity-login="${loginName}"]`)}),button=[...(row?.querySelectorAll(".identity-actions button")||[])].find((item)=>${pattern}.test(item.textContent));button?.click();return Boolean(button)})()`); need(clicked, `${kind} control is missing`);
  await cdp.wait(`({ready:Boolean(document.querySelector(".identity-confirmation"))})`, `${kind} confirmation`);
  if (password !== null) need(await cdp.evaluate(setter(".identity-confirmation input[type=password]", password)), "reset password input is missing");
  await cdp.evaluate(`(() => {const section=document.querySelector(".identity-confirmation"),button=[...section.querySelectorAll("button")].find((item)=>/确认操作|Confirm action/.test(item.textContent));button.click();return true})()`);
}
async function shot(cdp, directory, key) { const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }); const bytes = Buffer.from(captured.data, "base64"); need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is invalid"); const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" }); return { key, path: relative(ROOT, path), digest: digest(bytes) }; }

function apiRequest(origin, path, { method = "GET", body = null, session = null } = {}) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((done, reject) => { const target = new URL(path, origin); const request = https.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method, rejectUnauthorized: false, timeout: 15_000, headers: { accept: "application/json", ...(session ? { cookie: session.cookie } : {}), ...(payload ? { "content-type": "application/json", "content-length": payload.length, origin: new URL(origin).origin } : {}), ...(session?.csrf ? { "x-csrf-token": session.csrf } : {}) } }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => done({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) })); }); request.on("error", reject); request.on("timeout", () => request.destroy(new Error(`request timeout: ${path}`))); if (payload) request.write(payload); request.end(); });
}
async function apiSignIn(origin, loginName, password) { const response = await apiRequest(origin, "/api/auth/sign-in", { method: "POST", body: { loginName, password } }); if (response.status !== 200) return { status: response.status, session: null }; const value = JSON.parse(response.bytes.toString("utf8")); return { status: 200, session: { cookie: (response.headers["set-cookie"] ?? []).map((item) => item.split(";", 1)[0]).join("; "), csrf: value.csrfToken } }; }

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new BrowserSmokeError("Admin Users browser evidence exists; use a new run ID"); }).catch((error) => { if (error instanceof BrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))), images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.users" && [images["catalog-web"], images["catalog-platform-api"]].every((item) => SHA256.test(item ?? "")), "Admin Users deployment binding is invalid");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-admin-users-browser-")), port = await freePort();
  const chrome = spawn(options.chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [], errors = [];
  const temporaryAccount = temporarySmokeAccount();
  const { loginName, displayName } = temporaryAccount;
  let { initialPassword, replacementPassword } = temporaryAccount;
  const lifecycle = temporaryAccountLifecycle({ origin: options.origin, account: temporaryAccount, owner: accounts.owner, signIn: apiSignIn, request: apiRequest });
  let cleanup = { status: "pending", temporaryAccount: "unknown" };
  let cdp, browser = null, failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); need(target?.webSocketDebuggerUrl, "Chrome page target is missing"); cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => errors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300))); cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") errors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })]); browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    await signIn(cdp, options.origin, accounts.owner); await openUsers(cdp, options.origin);
    const adminTruth = await cdp.evaluate(`(() => {const actorRow=[...document.querySelectorAll(".identity-admin__table tbody tr")].find((row)=>/当前账户|Current account/.test(row.innerText));return{disabled:[...document.querySelectorAll(".admin-domain-card--disabled")].length,inertOpen:[...document.querySelectorAll("button")].filter((item)=>/^打开管理域$|^Open domain$/.test(item.textContent.trim())&&!item.disabled).length,selfDisabled:[...(actorRow?.querySelectorAll(".identity-actions button")||[])].some((item)=>/停用|Disable/.test(item.textContent)&&item.disabled)}})()`);
    operations.unfinishedDomainsDisabled = adminTruth.disabled >= 3 && adminTruth.inertOpen === 0; operations.selfDisableGuarded = adminTruth.selfDisabled; need(operations.unfinishedDomainsDisabled && operations.selfDisableGuarded, "administrator domain truthfulness or owner guard failed");
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true; screenshots.push(await shot(cdp, options.screenshots, "owner-desktop-zh-dark"));

    await lifecycle.prepare();
    lifecycle.markCreationAttempted();
    await createMember(cdp, loginName, displayName, initialPassword); await rowState(cdp, loginName, "active", "created member row"); operations.memberCreated = true;
    await createMember(cdp, loginName, displayName, initialPassword); const conflict = await cdp.wait(`(() => ({ready:/已经存在|already exists/.test(document.querySelector(".identity-admin__error")?.textContent||""),text:document.querySelector(".identity-admin__error")?.textContent||null}))()`, "localized duplicate conflict"); operations.duplicateConflictLocalized = Boolean(conflict.text); need(operations.duplicateConflictLocalized, "duplicate identity failure was not localized");
    await cdp.evaluate(`(() => {const button=[...document.querySelectorAll(".identity-admin__header button")].find((item)=>/创建成员|Create member/.test(item.textContent));button.click();return true})()`);

    const initialSession = await apiSignIn(options.origin, loginName, initialPassword); need(initialSession.status === 200 && initialSession.session, "created UI member could not sign in");
    await action(cdp, loginName, /停用|Disable/, "disable"); await rowState(cdp, loginName, "disabled", "disabled member row"); operations.memberDisabled = true;
    operations.sessionRevoked = (await apiRequest(options.origin, "/api/auth/session", { session: initialSession.session })).status === 401;
    operations.disabledLoginDenied = (await apiSignIn(options.origin, loginName, initialPassword)).status === 401; need(operations.sessionRevoked && operations.disabledLoginDenied, "disable did not revoke the session and block login");
    await action(cdp, loginName, /重新启用|Enable/, "enable"); await rowState(cdp, loginName, "active", "enabled member row"); operations.memberEnabled = true;
    const enabledSession = await apiSignIn(options.origin, loginName, initialPassword); need(enabledSession.status === 200 && enabledSession.session, "enabled member could not sign in");
    await action(cdp, loginName, /重置口令|Reset password/, "password reset", replacementPassword); await cdp.wait(`({ready:/口令已重置|password was reset/i.test(document.querySelector(".identity-admin__notice")?.textContent||"")})`, "password reset notice"); operations.passwordReset = true;
    operations.sessionRevoked = operations.sessionRevoked && (await apiRequest(options.origin, "/api/auth/session", { session: enabledSession.session })).status === 401;
    operations.oldPasswordDenied = (await apiSignIn(options.origin, loginName, initialPassword)).status === 401; operations.replacementLoginSucceeded = (await apiSignIn(options.origin, loginName, replacementPassword)).status === 200; need(operations.sessionRevoked && operations.oldPasswordDenied && operations.replacementLoginSucceeded, "password reset session semantics failed");
    await cdp.send("Page.reload", { ignoreCache: false }); await rowState(cdp, loginName, "active", "reloaded member row"); operations.reloadRetained = true;
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true; screenshots.push(await shot(cdp, options.screenshots, "owner-desktop-en-light"));

    await cdp.send("Page.navigate", { url: new URL("/admin/audit", options.origin).href }); const audit = await cdp.wait(`(() => {const actions=[...document.querySelectorAll(".audit-event__main strong")].map((item)=>item.textContent);return{ready:document.querySelector(".audit-integrity--valid")&&actions.includes("identity.local_member_created")&&actions.includes("identity.account_disabled")&&actions.includes("identity.account_enabled")&&actions.includes("identity.password_reset_by_administrator"),valid:Boolean(document.querySelector(".audit-integrity--valid")),actions}})()`, "identity audit events", 40_000); operations.auditEventsVisible = audit.actions.length >= 4; operations.auditChainVerified = audit.valid; need(operations.auditEventsVisible && operations.auditChainVerified, "browser audit chain view is incomplete");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await cdp.send("Page.navigate", { url: new URL("/admin/users", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".identity-admin"))})`, "mobile Users administration"); const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme})`); operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light"; need(operations.mobileNoOverflow, "mobile Users layout overflowed or lost preferences"); screenshots.push(await shot(cdp, options.screenshots, "owner-mobile-en-light"));

    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/users", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member direct route denial"); const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/users",{credentials:"same-origin",headers:{accept:"application/json"}});const page=document.querySelector(".admin-access-denied")?.innerText||"";return{adminNav:[...document.querySelectorAll(".nav-item")].some((item)=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".identity-admin")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page),status:response.status}})()`); operations.memberAdminHidden = denied.adminNav === false; operations.memberApiDenied = denied.status === 403; operations.memberDirectRouteDenied = denied.panel === false && denied.denial === true && denied.ownerClaim === false && denied.memberClaim === true; screenshots.push(await shot(cdp, options.screenshots, "member-mobile-denied")); need(operations.memberAdminHidden && operations.memberApiDenied && operations.memberDirectRouteDenied, "ordinary member gained administrator visibility, access, or a misleading owner identity");
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Users browser operations did not pass"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally {
    try {
      // Stop browser requests before checking the account's final state.
      cdp?.close(); chrome.kill("SIGTERM");
      await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(3_000)]);
    } catch { failure = failure ?? { type: "BrowserCleanupError", message: "Browser shutdown failed" }; }
    try { cleanup = await lifecycle.cleanup(); }
    catch { cleanup = { status: "failed", temporaryAccount: "unknown" }; failure = cleanupFailure(failure); }
    try { await rm(profile, { recursive: true, force: true }); }
    catch { failure = failure ?? { type: "BrowserCleanupError", message: "Browser profile cleanup failed" }; }
    finally { clearSmokeAccounts(accounts); initialPassword = replacementPassword = temporaryAccount.initialPassword = temporaryAccount.replacementPassword = ""; }
  }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-users-browser-smoke.v1", runId: options.runId, featureKey: "admin.users", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser, operations, screenshots, cleanup, console: { errorCount: errors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new BrowserSmokeError(`Admin Users browser smoke failed; evidence: ${relative(ROOT, options.output)}`); process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}
main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Users browser smoke failed"}\n`); process.exitCode = 1; });
