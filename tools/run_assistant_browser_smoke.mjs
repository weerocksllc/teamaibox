#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^assistant-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class AssistantBrowserSmokeError extends Error {}

const requireValue = (condition, message) => {
  if (!condition) throw new AssistantBrowserSmokeError(message);
};
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sortValue = (value) => Array.isArray(value)
  ? value.map(sortValue)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]))
    : value;
const canonical = (value) => Buffer.from(JSON.stringify(sortValue(value)));

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    requireValue(key?.startsWith("--") && value, "Assistant browser smoke arguments are incomplete");
    values[key.slice(2)] = value;
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) {
    requireValue(typeof values[key] === "string", `Assistant browser smoke ${key} is required`);
  }
  const origin = new URL(values.origin);
  requireValue(
    origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/",
    "Assistant browser smoke requires an exact HTTPS appliance origin",
  );
  requireValue(RUN_ID.test(values["run-id"]), "Assistant browser smoke run ID is invalid");
  const result = {
    origin: origin.href,
    runId: values["run-id"],
    deploymentEvidence: resolve(values["deployment-evidence"]),
    output: resolve(values.output),
    screenshots: resolve(values.screenshots),
    chrome: values.chrome ?? DEFAULT_CHROME,
  };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    requireValue(scoped && scoped !== ".." && !scoped.startsWith("../"), "Assistant browser smoke artifact escapes the repository");
  }
  return result;
}

async function credentialsFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const accounts = { owner: value.owner, member: value.member };
    for (const [key, account] of Object.entries(accounts)) {
      requireValue(
        typeof account?.loginName === "string" && typeof account?.password === "string" && account.password.length >= 8,
        `${key} browser credential is unavailable`,
      );
    }
    return accounts;
  } finally {
    raw.fill(0);
  }
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

async function waitForJson(url, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new AssistantBrowserSmokeError(`Chrome DevTools did not become ready: ${lastError?.message ?? "timeout"}`);
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = new Map();

  static async connect(url) {
    const client = new Cdp();
    client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener("open", resolvePromise, { once: true });
      client.#socket.addEventListener("error", () => reject(new AssistantBrowserSmokeError("Chrome DevTools WebSocket failed")), { once: true });
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
      if (value.error) pending.reject(new AssistantBrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`));
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
      this.#pending.set(id, { method, resolve: resolvePromise, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new AssistantBrowserSmokeError(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "browser evaluation failed",
      );
    }
    return result.result?.value;
  }

  async wait(expression, label, timeoutMilliseconds = 30000) {
    const deadline = Date.now() + timeoutMilliseconds;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      if (last?.ready === true) return last;
      await sleep(200);
    }
    throw new AssistantBrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 360)}`);
  }

  close() { this.#socket.close(); }
}

function inputSetter(selector, value) {
  return `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event("input",{bubbles:true})); element.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`;
}

function textareaSetter(selector, value) {
  return `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event("input",{bubbles:true})); element.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`;
}

async function signIn(cdp, origin, account, label) {
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(
    `(() => ({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)}))()`,
    `${label} sign-in form`,
  );
  requireValue(await cdp.evaluate(inputSetter("#login-name", account.loginName)) === true, `${label} login input is missing`);
  requireValue(await cdp.evaluate(inputSetter("#login-password", account.password)) === true, `${label} password input is missing`);
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(
    `(() => ({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null}))()`,
    `${label} authenticated workspace`,
  );
}

async function openAssistant(cdp, label) {
  const card = await cdp.wait(
    `(() => { const button=[...document.querySelectorAll("button.application-card")].find((item)=>/^(AI 助手|AI Assistant)$/.test(item.querySelector(".application-card__copy strong")?.textContent?.trim()||"")); return {ready:Boolean(button&&!button.disabled),found:Boolean(button),disabled:button?.disabled??null}; })()`,
    `${label} Assistant catalog card`,
    30000,
  );
  requireValue(card.found && card.disabled === false, `${label} Assistant catalog card is not launchable`);
  await cdp.evaluate(`(() => { [...document.querySelectorAll("button.application-card")].find((item)=>/^(AI 助手|AI Assistant)$/.test(item.querySelector(".application-card__copy strong")?.textContent?.trim()||"")).click(); return true; })()`);
  return cdp.wait(
    `(() => ({ready:Boolean(document.querySelector(".assistant-workspace")&&document.querySelector(".assistant-workspace__composer textarea")&&!document.querySelector(".assistant-empty .auth-spinner")),error:document.querySelector(".assistant-error")?.innerText||null,conversationCount:document.querySelectorAll(".assistant-conversation-list button").length}))()`,
    `${label} Assistant workspace`,
    30000,
  );
}

async function selectAnswerMode(cdp) {
  const selected = await cdp.evaluate(`(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/仅回答|Answer only/.test(item.innerText)); if(!button)return false; button.click(); return true; })()`);
  requireValue(selected === true, "Assistant Answer-only mode is unavailable");
  await cdp.wait(
    `(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/仅回答|Answer only/.test(item.innerText)); return {ready:Boolean(button?.classList.contains("is-selected"))}; })()`,
    "Assistant Answer-only mode selection",
  );
}

async function startNewConversation(cdp, previousCount) {
  requireValue(
    await cdp.evaluate(`(() => { const button=document.querySelector(".assistant-new-conversation"); if(!button)return false; button.click(); return true; })()`) === true,
    "Assistant new-conversation control is unavailable",
  );
  return cdp.wait(
    `(() => { const count=document.querySelectorAll(".assistant-conversation-list button").length; const active=document.querySelector(".assistant-conversation-list button.is-active"); const empty=document.querySelector(".assistant-empty"); return {ready:Boolean(count>${previousCount}&&active&&empty&&!empty.querySelector(".auth-spinner")),conversationCount:count}; })()`,
    "new Assistant conversation",
    30000,
  );
}

async function waitForRealtime(cdp, label) {
  return cdp.wait(
    `(() => ({ready:Boolean(document.querySelector(".assistant-connection--connected")),state:document.querySelector(".assistant-connection")?.textContent?.trim()||null}))()`,
    `${label} Assistant event stream`,
    30000,
  );
}

async function submitAnswer(cdp, prompt) {
  requireValue(
    await cdp.evaluate(textareaSetter(".assistant-workspace__composer textarea", prompt)) === true,
    "Assistant composer is missing",
  );
  await cdp.evaluate(`document.querySelector(".assistant-workspace__composer").requestSubmit()`);
  return cdp.wait(
    `(() => { const messages=[...document.querySelectorAll(".assistant-message--assistant")]; const message=messages.at(-1); const completed=message?.querySelector(".assistant-message-status--completed"); const failed=message?.querySelector(".assistant-message-status--failed"); const content=(message?.querySelector(".assistant-message__content")?.textContent||"").trim(); return {ready:Boolean(completed&&content.length>0&&message.querySelector(".assistant-routing")&&message.querySelector(".assistant-usage")),failed:Boolean(failed),contentChars:content.length,routingVisible:Boolean(message?.querySelector(".assistant-routing")),usageVisible:Boolean(message?.querySelector(".assistant-usage")),error:document.querySelector(".assistant-error")?.innerText||null}; })()`,
    "real Assistant answer",
    180000,
  );
}

async function ownerConversationId(cdp) {
  const value = await cdp.evaluate(`(async()=>{ const response=await fetch("/api/v1/assistant/conversations",{credentials:"same-origin",headers:{accept:"application/json"}}); const body=await response.json(); return {status:response.status,id:body?.data?.[0]?.id||null}; })()`);
  requireValue(value?.status === 200 && typeof value.id === "string", "owner Assistant conversation ID is unavailable");
  return value.id;
}

async function refreshAndVerifyPersistence(cdp, label) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame"))}))()`, `${label} workspace reload`, 30000);
  await openAssistant(cdp, `${label} persistence`);
  const persisted = await cdp.wait(
    `(() => { const messages=[...document.querySelectorAll(".assistant-message--assistant")]; const message=messages.at(-1); const content=(message?.querySelector(".assistant-message__content")?.textContent||"").trim(); return {ready:Boolean(message?.querySelector(".assistant-message-status--completed")&&content.length>0&&message.querySelector(".assistant-routing")&&message.querySelector(".assistant-usage")),conversationCount:document.querySelectorAll(".assistant-conversation-list button").length,contentChars:content.length,routingVisible:Boolean(message?.querySelector(".assistant-routing")),usageVisible:Boolean(message?.querySelector(".assistant-usage"))}; })()`,
    `${label} persisted Assistant answer`,
    30000,
  );
  await waitForRealtime(cdp, `${label} persisted`);
  return persisted;
}

async function verifyMemberIsolation(cdp, conversationId) {
  const encoded = JSON.stringify(encodeURIComponent(conversationId));
  return cdp.evaluate(`(async()=>{ const id=${encoded}; const detail=await fetch("/api/v1/assistant/conversations/"+id,{credentials:"same-origin",headers:{accept:"application/json"}}); const events=await fetch("/api/v1/assistant/conversations/"+id+"/events?after=0",{credentials:"same-origin",headers:{accept:"text/event-stream"}}); return {detailDenied:[403,404].includes(detail.status),detailStatus:detail.status,eventDenied:[403,404].includes(events.status),eventStatus:events.status}; })()`);
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const bytes = Buffer.from(captured.data, "base64");
  requireValue(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "Assistant browser screenshot is not PNG",
  );
  const path = join(directory, `${key}.png`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output)
    .then(() => { throw new AssistantBrowserSmokeError("Assistant browser evidence already exists; use a new run ID"); })
    .catch((error) => { if (error instanceof AssistantBrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });

  const deploymentBytes = await readFile(options.deploymentEvidence);
  const deployment = JSON.parse(deploymentBytes);
  const web = deployment.imageBindings?.find((item) => item.component === "catalog-web");
  requireValue(
    deployment.status === "passed" && deployment.featureKey === "official.assistant" && SHA256.test(web?.imageId ?? ""),
    "Assistant browser deployment binding is invalid",
  );

  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-assistant-browser-"));
  const port = await freePort();
  const chrome = spawn(options.chrome, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--ignore-certificate-errors",
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  const startedAt = new Date().toISOString();
  const prompt = `Return only the Chinese text 浏览器验收通过. Reference ${options.runId} nowhere in the answer.`;
  const journeys = [];
  const consoleErrors = [];
  let cdp, browser = null, failure = null;
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page");
    requireValue(target?.webSocketDebuggerUrl, "Chrome page target is unavailable");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push({
      kind: "exception",
      text: String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300),
    }));
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") consoleErrors.push({ kind: "console", text: String(event.args?.[0]?.value ?? "console error").slice(0, 300) });
    });
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }),
    ]);
    browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    await signIn(cdp, options.origin, accounts.owner, "owner");
    const opened = await openAssistant(cdp, "owner");
    const created = await startNewConversation(cdp, opened.conversationCount);
    await waitForRealtime(cdp, "owner new conversation");
    await selectAnswerMode(cdp);
    const answered = await submitAnswer(cdp, prompt);
    requireValue(answered.failed === false && answered.contentChars > 0, "Assistant returned no completed visible answer");
    const conversationId = await ownerConversationId(cdp);
    const persisted = await refreshAndVerifyPersistence(cdp, "owner");
    const ownerScreenshot = await screenshot(cdp, options.screenshots, "owner-answer-persisted");
    journeys.push({
      key: "owner",
      role: "owner",
      launchable: true,
      newConversationCreated: created.conversationCount > opened.conversationCount,
      realtimeConnected: true,
      answerModeSelected: true,
      realAnswerCompleted: true,
      responseNonEmpty: answered.contentChars > 0,
      routingVisible: answered.routingVisible,
      usageVisible: answered.usageVisible,
      persistedAfterReload: persisted.contentChars > 0 && persisted.conversationCount >= Math.max(1, opened.conversationCount),
      ownershipDenied: null,
      eventOwnershipDenied: null,
      screenshot: ownerScreenshot,
    });

    await signIn(cdp, options.origin, accounts.member, "ordinary user");
    await openAssistant(cdp, "ordinary user");
    const isolation = await verifyMemberIsolation(cdp, conversationId);
    requireValue(isolation.detailDenied === true && isolation.eventDenied === true, "ordinary user can access the owner's Assistant conversation");
    const memberScreenshot = await screenshot(cdp, options.screenshots, "ordinary-user-isolated");
    journeys.push({
      key: "ordinary-user",
      role: "member",
      launchable: true,
      newConversationCreated: null,
      realtimeConnected: null,
      answerModeSelected: null,
      realAnswerCompleted: null,
      responseNonEmpty: null,
      routingVisible: null,
      usageVisible: null,
      persistedAfterReload: null,
      ownershipDenied: isolation.detailDenied,
      eventOwnershipDenied: isolation.eventDenied,
      screenshot: memberScreenshot,
    });
    requireValue(consoleErrors.length === 0, `browser emitted ${consoleErrors.length} error events`);
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]);
    await rm(profile, { recursive: true, force: true });
    accounts.owner.password = accounts.member.password = "[REDACTED]";
  }

  const evidence = {
    schemaVersion: 1,
    runnerId: "teamaibox.assistant-browser-smoke.v1",
    runId: options.runId,
    featureKey: "official.assistant",
    scope: "answer-mode-only",
    status: failure ? "failed" : "passed",
    origin: options.origin,
    startedAt,
    completedAt: new Date().toISOString(),
    browser,
    journeys,
    console: { errorCount: consoleErrors.length },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) },
    deployment: {
      evidencePath: relative(ROOT, options.deploymentEvidence),
      evidenceDigest: digest(deploymentBytes),
      runId: deployment.runId,
      webImageId: web.imageId,
    },
    privacy: {
      credentialsRetained: false,
      userContentRetained: false,
      commandOutputRetained: false,
      syntheticContentOnly: true,
    },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new AssistantBrowserSmokeError(`Assistant browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, journeyCount: journeys.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? "Assistant browser smoke failed"}\n`);
  process.exitCode = 1;
});
