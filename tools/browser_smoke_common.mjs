import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const need = (condition, message) => { if (!condition) throw new Error(message); };
export const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
export const canonical = (value) => Buffer.from(JSON.stringify(sorted(value)));

export async function credentialsFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    for (const key of ["owner", "member"]) need(typeof value[key]?.loginName === "string" && typeof value[key]?.password === "string" && value[key].password.length >= 8, `${key} browser credential is unavailable`);
    return { owner: value.owner, member: value.member };
  } finally { raw.fill(0); }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitJson(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await sleep(100);
  }
  throw new Error("Headless Chrome did not become ready");
}

export class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const value = new Cdp(); value.#socket = new WebSocket(url);
    await new Promise((done, reject) => { value.#socket.addEventListener("open", done, { once: true }); value.#socket.addEventListener("error", () => reject(new Error("Chrome DevTools connection failed")), { once: true }); });
    value.#socket.addEventListener("message", (event) => value.#message(event)); return value;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) { const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id); value.error ? pending.reject(new Error(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return; }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 60_000) {
    const id = this.#id++;
    return new Promise((done, reject) => { const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`CDP ${method} timed out`)); }, timeout); this.#pending.set(id, { method, resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.#socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed"); return value.result?.value; }
  async wait(expression, label, timeout = 30_000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await this.evaluate(expression).catch((error) => ({ error: error.message })); if (last?.ready === true) return last; await sleep(200); } throw new Error(`${label} did not become ready: ${JSON.stringify(last).slice(0, 300)}`); }
  close() { this.#socket.close(); }
}

export const setter = (selector, value, prototype = "HTMLInputElement") => `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(${prototype}.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;

export async function signIn(cdp, origin, account) {
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, "sign-in form");
  need(await cdp.evaluate(setter("#login-name", account.loginName)), "login input is missing"); need(await cdp.evaluate(setter("#login-password", account.password)), "password input is missing");
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, "authenticated workbench");
}

export async function setPreferences(cdp, { locale, theme }) {
  await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:Boolean(document.querySelector(".profile-popover"))})`, "profile preferences");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[0].querySelectorAll("button")[${locale === "en" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "locale switch");
  await cdp.evaluate(`document.querySelectorAll(".profile-popover .preference-group")[1].querySelectorAll("button")[${theme === "dark" ? 1 : 0}].click(),true`); await cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "theme switch");
  await cdp.evaluate(`document.querySelector(".profile-trigger").click(),true`); await cdp.wait(`({ready:!document.querySelector(".profile-popover")})`, "profile preferences close");
}

export async function shotElement(cdp, root, directory, key, selector) {
  const box = await cdp.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)}),rect=element?.getBoundingClientRect();return rect?{x:rect.x+scrollX,y:rect.y+scrollY,width:rect.width,height:rect.height}:null})()`);
  need(box && box.width > 0 && box.height > 0 && box.width <= 2000 && box.height <= 5000, `${key} screenshot element is invalid`);
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { ...box, scale: 1 } });
  const bytes = Buffer.from(captured.data, "base64"); need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is invalid");
  const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" }); return { key, path: relative(root, path), digest: digest(bytes) };
}

export async function startChrome(chromePath = CHROME) {
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-browser-")), port = await freePort();
  const process = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const targets = await waitJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); need(target?.webSocketDebuggerUrl, "Chrome page target is missing");
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl), errors = [];
  cdp.on("Runtime.exceptionThrown", (event) => errors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
  cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") errors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })]);
  return { profile, process, cdp, errors, browser: await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`) };
}

export async function stopChrome(runtime) {
  runtime.cdp?.close(); runtime.process.kill("SIGTERM"); await Promise.race([new Promise((done) => runtime.process.once("exit", done)), sleep(3_000)]); await rm(runtime.profile, { recursive: true, force: true });
}
