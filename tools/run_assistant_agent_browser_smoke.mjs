#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^assistant-agent-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class AssistantAgentBrowserSmokeError extends Error {}

const requireValue = (condition, message) => {
  if (!condition) throw new AssistantAgentBrowserSmokeError(message);
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
    requireValue(key?.startsWith("--") && value, "Assistant Agent browser arguments are incomplete");
    values[key.slice(2)] = value;
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) {
    requireValue(typeof values[key] === "string", `Assistant Agent browser ${key} is required`);
  }
  const origin = new URL(values.origin);
  requireValue(
    origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/",
    "Assistant Agent browser requires an exact HTTPS appliance origin",
  );
  requireValue(RUN_ID.test(values["run-id"]), "Assistant Agent browser run ID is invalid");
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
    requireValue(scoped && scoped !== ".." && !scoped.startsWith("../"), "Assistant Agent browser artifact escapes the repository");
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
  throw new AssistantAgentBrowserSmokeError(`Chrome DevTools did not become ready: ${lastError?.message ?? "timeout"}`);
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
      client.#socket.addEventListener("error", () => reject(new AssistantAgentBrowserSmokeError("Chrome DevTools WebSocket failed")), { once: true });
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
      if (value.error) pending.reject(new AssistantAgentBrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`));
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
      throw new AssistantAgentBrowserSmokeError(
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
      await sleep(250);
    }
    throw new AssistantAgentBrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 360)}`);
  }

  async setFileInput(selector, path) {
    const { root } = await this.send("DOM.getDocument", { depth: 2, pierce: true });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    requireValue(nodeId > 0, `Browser file input is missing: ${selector}`);
    await this.send("DOM.setFileInputFiles", { files: [path], nodeId });
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
  );
  requireValue(card.found && card.disabled === false, `${label} Assistant catalog card is not launchable`);
  await cdp.evaluate(`(() => { [...document.querySelectorAll("button.application-card")].find((item)=>/^(AI 助手|AI Assistant)$/.test(item.querySelector(".application-card__copy strong")?.textContent?.trim()||"")).click(); return true; })()`);
  return cdp.wait(
    `(() => ({ready:Boolean(document.querySelector(".assistant-workspace")&&document.querySelector(".assistant-workspace__composer textarea")&&!document.querySelector(".assistant-empty .auth-spinner")),error:document.querySelector(".assistant-error")?.innerText||null,conversationCount:document.querySelectorAll(".assistant-conversation-list button").length}))()`,
    `${label} Assistant workspace`,
    30000,
  );
}

async function startNewConversation(cdp, previousCount, label) {
  requireValue(
    await cdp.evaluate(`(() => { const button=document.querySelector(".assistant-new-conversation"); if(!button)return false; button.click(); return true; })()`) === true,
    `${label} new-conversation control is unavailable`,
  );
  return cdp.wait(
    `(() => { const count=document.querySelectorAll(".assistant-conversation-list button").length; const active=document.querySelector(".assistant-conversation-list button.is-active"); const empty=document.querySelector(".assistant-empty"); return {ready:Boolean(count>${previousCount}&&active&&empty&&!empty.querySelector(".auth-spinner")),conversationCount:count}; })()`,
    `${label} new Assistant conversation`,
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

async function selectAgentMode(cdp, label) {
  const selected = await cdp.evaluate(`(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/^Agent(?: 模式)?$/i.test(item.innerText.trim())); if(!button)return false; button.click(); return true; })()`);
  requireValue(selected === true, `${label} Assistant Agent mode is unavailable`);
  await cdp.wait(
    `(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/^Agent(?: 模式)?$/i.test(item.innerText.trim())); return {ready:Boolean(button?.classList.contains("is-selected"))}; })()`,
    `${label} Assistant Agent mode selection`,
  );
}

async function selectAnswerMode(cdp, label) {
  const selected = await cdp.evaluate(`(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/^(仅回答|Answer only)$/i.test(item.innerText.trim())); if(!button)return false; button.click(); return true; })()`);
  requireValue(selected === true, `${label} Assistant Answer mode is unavailable`);
  await cdp.wait(
    `(() => { const button=[...document.querySelectorAll(".assistant-mode-selector button")].find((item)=>/^(仅回答|Answer only)$/i.test(item.innerText.trim())); return {ready:Boolean(button?.classList.contains("is-selected"))}; })()`,
    `${label} Assistant Answer mode selection`,
  );
}

async function submitAnswerWithSource(cdp, label, attachmentPath, attachmentName, marker) {
  await selectAnswerMode(cdp, label);
  await cdp.setFileInput(".assistant-attach input[type=file]", attachmentPath);
  await cdp.wait(
    `(() => ({ready:document.querySelector(".assistant-attachment span")?.textContent?.trim()===${JSON.stringify(attachmentName)}}))()`,
    `${label} Assistant protected input selection`,
  );
  requireValue(
    await cdp.evaluate(textareaSetter(".assistant-workspace__composer textarea", `用一句简短中文确认已收到附件标记 ${marker}，不要解释。`)) === true,
    `${label} Assistant composer is missing`,
  );
  await cdp.evaluate(`document.querySelector(".assistant-workspace__composer").requestSubmit()`);
  const result = await cdp.wait(
    `(() => { const message=[...document.querySelectorAll(".assistant-message--assistant")].at(-1); const completed=message?.querySelector(".assistant-message-status--completed"); const failed=message?.querySelector(".assistant-message-status--failed"); const source=[...message?.querySelectorAll(".assistant-message-links a")||[]].find((item)=>item.getAttribute("href")?.startsWith("/api/v1/assistant/artifacts/")); const model=[...message?.querySelectorAll(".assistant-routing code")||[]].some((item)=>item.textContent?.trim()==="local/qwen3.6-35b-nvfp4"); return {ready:Boolean(completed&&source&&model&&message.querySelector(".assistant-usage")&&!document.querySelector(".assistant-attachment")),failed:Boolean(failed),sourcePath:source?.getAttribute("href")||null}; })()`,
    `${label} protected source Answer completion`,
    300000,
  );
  requireValue(result.failed === false && typeof result.sourcePath === "string", `${label} protected source Answer failed`);
  const download = await cdp.evaluate(`(async()=>{ const response=await fetch(${JSON.stringify(result.sourcePath)},{credentials:"same-origin"}); const text=await response.text(); return {status:response.status,matched:text.includes(${JSON.stringify(marker)})}; })()`);
  requireValue(download?.status === 200 && download.matched === true, `${label} protected source citation is not downloadable`);
  return { uploaded: true, cited: true, downloaded: true };
}

async function submitAgent(cdp, label, proofName, marker) {
  const expectedContent = `${marker}=passed\n`;
  const prompt = `Use the write or edit tool to create exactly /workspace/${proofName} with exact content ${JSON.stringify(expectedContent)}. Do not modify another file. Then briefly report completion.`;
  requireValue(
    await cdp.evaluate(textareaSetter(".assistant-workspace__composer textarea", prompt)) === true,
    `${label} Assistant composer is missing`,
  );
  await cdp.evaluate(`document.querySelector(".assistant-workspace__composer").requestSubmit()`);
  const confirmation = await cdp.wait(
    `(() => { const card=document.querySelector(".assistant-confirmation"); const scope=card?.querySelector("pre")?.textContent||""; const approve=[...card?.querySelectorAll("button")||[]].find((item)=>/允许一次|Allow once/.test(item.innerText)); const failed=[...document.querySelectorAll(".assistant-message--assistant")].at(-1)?.querySelector(".assistant-message-status--failed"); return {ready:Boolean(failed||(card&&approve&&scope.includes(${JSON.stringify(proofName)}))),failed:Boolean(failed),scopeBound:scope.includes(${JSON.stringify(proofName)})}; })()`,
    `${label} Agent operation confirmation`,
    300000,
  );
  requireValue(confirmation.failed === false && confirmation.scopeBound === true, `${label} Agent confirmation scope is invalid`);
  requireValue(
    await cdp.evaluate(`(() => { const card=document.querySelector(".assistant-confirmation"); const approve=[...card?.querySelectorAll("button")||[]].find((item)=>/允许一次|Allow once/.test(item.innerText)); if(!approve)return false; approve.click(); return true; })()`) === true,
    `${label} Agent approval control is unavailable`,
  );
  return cdp.wait(
    `(() => { const messages=[...document.querySelectorAll(".assistant-message--assistant")]; const message=messages.at(-1); const completed=message?.querySelector(".assistant-message-status--completed"); const failed=message?.querySelector(".assistant-message-status--failed"); const content=(message?.querySelector(".assistant-message__content")?.textContent||"").trim(); const tool=message?.querySelector(".assistant-tools .tool-state--succeeded"); const routing=message?.querySelector(".assistant-routing"); const model=[...routing?.querySelectorAll("code")||[]].some((item)=>item.textContent?.trim()==="agent.bridge"); const artifact=[...message?.querySelectorAll(".assistant-message-links a")||[]].find((item)=>item.getAttribute("href")?.startsWith("/api/v1/assistant/artifacts/")); return {ready:Boolean(completed&&content.length>0&&tool&&routing&&model&&artifact&&message.querySelector(".assistant-usage")&&!document.querySelector(".assistant-confirmation")),failed:Boolean(failed),contentChars:content.length,completedToolVisible:Boolean(tool),routingVisible:Boolean(routing&&model),usageVisible:Boolean(message?.querySelector(".assistant-usage")),artifactPath:artifact?.getAttribute("href")||null}; })()`,
    `${label} real Agent completion`,
    300000,
  ).then(async (result) => {
    const downloaded = await cdp.evaluate(`(async()=>{ const response=await fetch(${JSON.stringify(result.artifactPath)},{credentials:"same-origin"}); const text=await response.text(); return {status:response.status,matched:text.includes(${JSON.stringify(`${marker}=passed`)})}; })()`);
    requireValue(downloaded?.status === 200 && downloaded.matched === true, `${label} protected Agent artifact is not downloadable`);
    return { ...result, artifactVisible: true, artifactDownloaded: true };
  });
}

async function activeConversationFacts(cdp) {
  const value = await cdp.evaluate(`(async()=>{ const list=await fetch("/api/v1/assistant/conversations",{credentials:"same-origin",headers:{accept:"application/json"}}); const listBody=await list.json(); const id=listBody?.data?.[0]?.id; if(list.status!==200||!id)return {status:list.status,id:null}; const detail=await fetch("/api/v1/assistant/conversations/"+encodeURIComponent(id),{credentials:"same-origin",headers:{accept:"application/json"}}); const body=await detail.json(); return {status:detail.status,id,approved:(body?.confirmations||[]).filter((item)=>item.status==="approved").length,completedAgent:(body?.messages||[]).some((item)=>item.role==="assistant"&&item.status==="completed"&&item.effectiveMode==="agent"&&item.routing?.modelKey==="agent.bridge"&&(item.toolCalls||[]).some((tool)=>tool.status==="succeeded")),protectedArtifact:(body?.messages||[]).some((item)=>item.role==="assistant"&&(item.artifacts||[]).some((artifact)=>artifact.role==="output"&&artifact.downloadPath)),sourceCitation:(body?.messages||[]).some((item)=>item.role==="assistant"&&(item.sources||[]).some((source)=>source.url))}; })()`);
  requireValue(value?.status === 200 && typeof value.id === "string", "active Agent conversation is unavailable");
  requireValue(value.approved === 1 && value.completedAgent === true && value.protectedArtifact === true && value.sourceCitation === true,
    "Assistant durable source or Agent artifact facts are incomplete");
  return value;
}

async function refreshAndVerifyPersistence(cdp, label) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.wait(`(() => ({ready:Boolean(document.querySelector(".app-frame"))}))()`, `${label} workspace reload`, 30000);
  await openAssistant(cdp, `${label} persistence`);
  const persisted = await cdp.wait(
    `(() => { const messages=[...document.querySelectorAll(".assistant-message--assistant")]; const message=messages.at(-1); const content=(message?.querySelector(".assistant-message__content")?.textContent||"").trim(); const tool=message?.querySelector(".assistant-tools .tool-state--succeeded"); const routing=message?.querySelector(".assistant-routing"); const model=[...routing?.querySelectorAll("code")||[]].some((item)=>item.textContent?.trim()==="agent.bridge"); const artifact=[...message?.querySelectorAll(".assistant-message-links a")||[]].some((item)=>item.getAttribute("href")?.startsWith("/api/v1/assistant/artifacts/")); const source=[...messages].some((item)=>[...item.querySelectorAll(".assistant-message-links a")].some((link)=>link.getAttribute("href")?.startsWith("/api/v1/assistant/artifacts/"))); return {ready:Boolean(message?.querySelector(".assistant-message-status--completed")&&content.length>0&&tool&&routing&&model&&artifact&&source&&message.querySelector(".assistant-usage")),conversationCount:document.querySelectorAll(".assistant-conversation-list button").length,completedToolVisible:Boolean(tool),contentChars:content.length,protectedArtifactVisible:Boolean(artifact),sourceVisible:Boolean(source)}; })()`,
    `${label} persisted Agent result`,
    30000,
  );
  await waitForRealtime(cdp, `${label} persisted`);
  const facts = await activeConversationFacts(cdp);
  return { persisted, facts };
}

async function verifyIsolation(cdp, conversationId) {
  const encoded = JSON.stringify(encodeURIComponent(conversationId));
  return cdp.evaluate(`(async()=>{ const id=${encoded}; const detail=await fetch("/api/v1/assistant/conversations/"+id,{credentials:"same-origin",headers:{accept:"application/json"}}); const events=await fetch("/api/v1/assistant/conversations/"+id+"/events?after=0&once=1",{credentials:"same-origin",headers:{accept:"text/event-stream"}}); return {detailDenied:[403,404].includes(detail.status),detailStatus:detail.status,eventDenied:[403,404].includes(events.status),eventStatus:events.status}; })()`);
}

async function verifyActionableUnavailableState(cdp, label) {
  const opened = await cdp.evaluate(`(() => { const button=[...document.querySelectorAll(".assistant-conversation-list button")].find((item)=>item.textContent?.includes("Assistant unavailable product proof")); if(!button)return false; button.click(); return true; })()`);
  requireValue(opened === true, `${label} unavailable-state conversation is missing`);
  return cdp.wait(
    `(() => { const message=[...document.querySelectorAll(".assistant-message--assistant")].find((item)=>item.querySelector(".assistant-message-status--failed")); const alert=message?.querySelector(".assistant-run-error"); const code=alert?.querySelector("code")?.textContent?.trim()||null; const guidance=alert?.querySelector("span")?.textContent?.trim()||""; return {ready:Boolean(alert&&code==="compute_worker_unavailable"&&guidance.length>0),code,guidanceVisible:guidance.length>0}; })()`,
    `${label} actionable unavailable state`,
    30000,
  );
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(captured.data, "base64");
  requireValue(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "Assistant Agent browser screenshot is not PNG",
  );
  const path = join(directory, `${key}.png`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

function journey(key, role, answerResult, result, persistence, screenshotBinding, isolation = null, unavailable = null) {
  return {
    key,
    role,
    launchable: true,
    newConversationCreated: true,
    realtimeConnected: true,
    agentModeSelected: true,
    realAgentCompleted: true,
    responseNonEmpty: result.contentChars > 0,
    routingVisible: result.routingVisible,
    usageVisible: result.usageVisible,
    completedToolVisible: result.completedToolVisible,
    protectedInputUploaded: answerResult.uploaded,
    sourceCitationVisible: answerResult.cited,
    sourceCitationDownloaded: answerResult.downloaded,
    protectedAgentArtifactVisible: result.artifactVisible,
    protectedAgentArtifactDownloaded: result.artifactDownloaded,
    actionableUnavailableVisible: unavailable?.ready ?? null,
    unavailableErrorCodeVisible: unavailable?.code === "compute_worker_unavailable" ? true : null,
    confirmationApprovedExactlyOnce: persistence.facts.approved === 1,
    persistedAfterReload: persistence.persisted.contentChars > 0 && persistence.persisted.completedToolVisible,
    approvedConfirmationRetained: persistence.facts.approved === 1,
    ownershipDenied: isolation?.detailDenied ?? null,
    eventOwnershipDenied: isolation?.eventDenied ?? null,
    screenshot: screenshotBinding,
  };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output)
    .then(() => { throw new AssistantAgentBrowserSmokeError("Assistant Agent browser evidence already exists; use a new run ID"); })
    .catch((error) => { if (error instanceof AssistantAgentBrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });

  const deploymentBytes = await readFile(options.deploymentEvidence);
  const deployment = JSON.parse(deploymentBytes);
  const deploymentIdentity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/);
  requireValue(deploymentIdentity, "Assistant Agent browser deployment identity is invalid");
  const deploymentPlan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${deploymentIdentity[1]}-${deploymentIdentity[2]}.json`)));
  const web = deployment.imageBindings?.find((item) => item.component === "catalog-web");
  const webImageId = web?.imageId ?? deploymentPlan.environment?.TEAMAIBOX_CATALOG_WEB_IMAGE;
  requireValue(
    deployment.status === "passed" && SHA256.test(webImageId ?? "")
      && ["agent-owner-sandbox", "agent-member-sandbox", "agent-bridge-owner", "agent-bridge-member"].every((service) => deploymentPlan.featureServices?.includes(service)),
    "Assistant Agent browser deployment binding is invalid",
  );
  const deploymentCompletedAt = new Date(deployment.completedAt);
  requireValue(Number.isFinite(deploymentCompletedAt.getTime()), "Assistant Agent deployment completion time is invalid");
  const credentialTtlSeconds = 300;
  const credentialRotationNotBefore = new Date(deploymentCompletedAt.getTime() + credentialTtlSeconds * 1000);
  requireValue(Date.now() >= credentialRotationNotBefore.getTime(), "Assistant Agent browser must start after the original model credential expires");

  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-assistant-agent-browser-"));
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
  const proofKey = `${String(deployment.runId).replace(/[^a-z0-9-]/g, "-")}-${options.runId.split("-").at(-1)}`;
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
    const ownerOpened = await openAssistant(cdp, "owner");
    const ownerCreated = await startNewConversation(cdp, ownerOpened.conversationCount, "owner");
    requireValue(ownerCreated.conversationCount > ownerOpened.conversationCount, "owner Agent conversation was not created");
    await waitForRealtime(cdp, "owner");
    const ownerSourceName = `browser-source-owner-${proofKey}.txt`;
    const ownerSourceMarker = "TEAM_AI_BOX_BROWSER_SOURCE_OWNER";
    const ownerSourcePath = join(profile, ownerSourceName);
    await writeFile(ownerSourcePath, `${ownerSourceMarker}=passed\n`, { flag: "wx", mode: 0o600 });
    const ownerAnswer = await submitAnswerWithSource(cdp, "owner", ownerSourcePath, ownerSourceName, ownerSourceMarker);
    await selectAgentMode(cdp, "owner");
    const ownerResult = await submitAgent(cdp, "owner", `browser-agent-owner-${proofKey}.txt`, "TEAM_AI_BOX_BROWSER_AGENT_OWNER");
    requireValue(ownerResult.failed === false && ownerResult.contentChars > 0, "owner Agent returned no completed visible result");
    const ownerPersistence = await refreshAndVerifyPersistence(cdp, "owner");
    const unavailable = await verifyActionableUnavailableState(cdp, "owner");
    const ownerScreenshot = await screenshot(cdp, options.screenshots, "owner-agent-persisted");
    const ownerConversationId = ownerPersistence.facts.id;
    journeys.push(journey("owner", "owner", ownerAnswer, ownerResult, ownerPersistence, ownerScreenshot, null, unavailable));

    await signIn(cdp, options.origin, accounts.member, "ordinary user");
    const memberOpened = await openAssistant(cdp, "ordinary user");
    const memberCreated = await startNewConversation(cdp, memberOpened.conversationCount, "ordinary user");
    requireValue(memberCreated.conversationCount > memberOpened.conversationCount, "ordinary-user Agent conversation was not created");
    await waitForRealtime(cdp, "ordinary user");
    const memberSourceName = `browser-source-member-${proofKey}.txt`;
    const memberSourceMarker = "TEAM_AI_BOX_BROWSER_SOURCE_MEMBER";
    const memberSourcePath = join(profile, memberSourceName);
    await writeFile(memberSourcePath, `${memberSourceMarker}=passed\n`, { flag: "wx", mode: 0o600 });
    const memberAnswer = await submitAnswerWithSource(cdp, "ordinary user", memberSourcePath, memberSourceName, memberSourceMarker);
    await selectAgentMode(cdp, "ordinary user");
    const memberResult = await submitAgent(cdp, "ordinary user", `browser-agent-member-${proofKey}.txt`, "TEAM_AI_BOX_BROWSER_AGENT_MEMBER");
    requireValue(memberResult.failed === false && memberResult.contentChars > 0, "ordinary-user Agent returned no completed visible result");
    const memberPersistence = await refreshAndVerifyPersistence(cdp, "ordinary user");
    const isolation = await verifyIsolation(cdp, ownerConversationId);
    requireValue(isolation.detailDenied === true && isolation.eventDenied === true, "ordinary user can access the owner's Agent conversation");
    const memberScreenshot = await screenshot(cdp, options.screenshots, "ordinary-user-agent-isolated");
    journeys.push(journey("ordinary-user", "member", memberAnswer, memberResult, memberPersistence, memberScreenshot, isolation));
    requireValue(consoleErrors.length === 0, `browser emitted ${consoleErrors.length} error events`);
  } catch (error) {
    failure = {
      type: error?.constructor?.name ?? "Error",
      message: String(error?.message ?? error)
        .replace(/(password|token|secret|credential|authorization|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
        .slice(0, 400),
    };
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]);
    await rm(profile, { recursive: true, force: true });
    accounts.owner.password = accounts.member.password = "[REDACTED]";
  }

  const evidence = {
    schemaVersion: 1,
    runnerId: "teamaibox.assistant-agent-browser-smoke.v1",
    runId: options.runId,
    featureKey: "official.assistant",
    scope: "agent-mode-product-ui",
    status: failure ? "failed" : "passed",
    origin: options.origin,
    startedAt,
    completedAt: new Date().toISOString(),
    browser,
    journeys,
    console: { errorCount: consoleErrors.length },
    credentialRotation: {
      ttlSeconds: credentialTtlSeconds,
      deploymentCompletedAt: deployment.completedAt,
      notBefore: credentialRotationNotBefore.toISOString(),
      observedAt: startedAt,
      crossedBeforeBrowser: new Date(startedAt) >= credentialRotationNotBefore,
    },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) },
    deployment: {
      evidencePath: relative(ROOT, options.deploymentEvidence),
      evidenceDigest: digest(deploymentBytes),
      runId: deployment.runId,
      webImageId,
    },
    privacy: {
      credentialsRetained: false,
      promptContentRetained: false,
      modelOutputRetained: false,
      commandOutputRetained: false,
      syntheticContentOnly: true,
    },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new AssistantAgentBrowserSmokeError(`Assistant Agent browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, journeyCount: journeys.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? "Assistant Agent browser smoke failed"}\n`);
  process.exitCode = 1;
});
