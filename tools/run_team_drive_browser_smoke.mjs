#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^team-drive-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OPERATION_KEYS = [
  "folderCreated", "smallFileUploaded", "downloadIntegrity", "previewed", "versionAdded",
  "versionHistory", "renamed", "moved", "copiedWithVersions", "searched", "quotaVisible",
  "trashed", "restored", "shareCreated", "shareRecipientAccess", "shareRecipientDownloadIntegrity",
  "unauthorizedMutationDenied", "memberShareDenied", "memberShareDenialLocalized",
  "multipartInterrupted", "multipartResumed", "largeFileDownloadIntegrity",
];
const ACCEPTANCE_ENTRY = /^team-drive-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}-(?:destination|document\.txt|renamed\.txt|copy\.txt|private\.txt|large\.bin|member-folder)$/;

class BrowserSmokeError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new BrowserSmokeError(message); };
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sortValue(value)));

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    requireValue(argv[index]?.startsWith("--") && argv[index + 1], "browser smoke arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) {
    requireValue(values[key], `browser smoke ${key} is required`);
  }
  const origin = new URL(values.origin);
  requireValue(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "browser smoke requires an exact HTTPS appliance origin");
  requireValue(RUN_ID.test(values["run-id"]), "browser smoke run ID is invalid");
  const result = {
    origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]),
    output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? DEFAULT_CHROME,
  };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    requireValue(scoped && scoped !== ".." && !scoped.startsWith("../"), "browser smoke artifact escapes the repository");
  }
  return result;
}

async function credentialsFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const accounts = {
      owner: { key: "owner", role: "owner", value: value.owner },
      member: { key: "ordinary-user", role: "member", value: value.member },
    };
    for (const account of Object.values(accounts)) {
      requireValue(typeof account.value?.loginName === "string" && typeof account.value?.password === "string"
        && account.value.password.length >= 8, `browser ${account.key} credential is unavailable`);
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

async function waitForJson(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await sleep(100);
  }
  throw new BrowserSmokeError("Chrome DevTools did not become ready");
}

class Cdp {
  #socket; #nextId = 1; #pending = new Map(); #events = new Map();
  static async connect(url) {
    const client = new Cdp(); client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener("open", resolvePromise, { once: true });
      client.#socket.addEventListener("error", () => reject(new BrowserSmokeError("Chrome DevTools WebSocket failed")), { once: true });
    });
    client.#socket.addEventListener("message", (event) => client.#message(event)); return client;
  }
  #message(event) {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const pending = this.#pending.get(value.id); if (!pending) return; this.#pending.delete(value.id);
      value.error ? pending.reject(new BrowserSmokeError(`CDP ${pending.method} failed: ${value.error.message}`)) : pending.resolve(value.result ?? {}); return;
    }
    for (const handler of this.#events.get(value.method) ?? []) handler(value.params ?? {});
  }
  on(method, handler) { const values = this.#events.get(method) ?? []; values.push(handler); this.#events.set(method, values); }
  send(method, params = {}, timeout = 30000) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new BrowserSmokeError(`CDP ${method} timed out`));
      }, timeout);
      this.#pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, { byValue = true } = {}) {
    const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: byValue, userGesture: true }, 60000);
    if (value.exceptionDetails) throw new BrowserSmokeError(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "browser evaluation failed");
    return byValue ? value.result?.value : value.result;
  }
  async wait(expression, label, timeout = 30000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => ({ error: error.message }));
      if (last?.ready === true) return last;
      await sleep(200);
    }
    throw new BrowserSmokeError(`${label} did not become ready: ${JSON.stringify(last).slice(0, 300)}`);
  }
  close() { this.#socket.close(); }
}

const inputSetter = (selector, value) => `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;
const frame = (expression) => `(() => {const iframe=globalThis.document.querySelector('iframe[src^="/plugins/official.team-drive"]'),frameDocument=iframe?.contentDocument;if(!frameDocument)return null;const document=frameDocument;return(${expression})})()`;

async function signIn(cdp, origin, account) {
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(`({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)})`, `${account.key} sign-in form`);
  requireValue(await cdp.evaluate(inputSetter("#login-name", account.value.loginName)), `${account.key} login input is missing`);
  requireValue(await cdp.evaluate(inputSetter("#login-password", account.value.password)), `${account.key} password input is missing`);
  await cdp.evaluate(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(`({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null})`, `${account.key} authenticated workspace`);
}

async function browserJson(cdp, path, { method = "GET", body = null } = {}) {
  return cdp.evaluate(`(async()=>{const body=${body === null ? "null" : JSON.stringify(JSON.stringify(body))},headers={accept:"application/json"};if(body!==null){const token=document.cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith("__Host-teamaibox-csrf="))?.split("=").slice(1).join("=");headers["content-type"]="application/json";headers["x-csrf-token"]=token||""}const response=await fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:"same-origin",headers,body});const value=await response.json().catch(()=>null);return{status:response.status,value}})()`);
}

async function openTeamDrive(cdp, label) {
  const card = await cdp.wait(`(() => {const button=[...document.querySelectorAll("button.application-card")].find(item=>/团队网盘|Team Drive/i.test(item.innerText));return{ready:Boolean(button&&!button.disabled),found:Boolean(button),disabled:button?.disabled??null}})()`, `${label} Team Drive card`, 30000);
  requireValue(card.found && !card.disabled, `${label} Team Drive card is not launchable`);
  await cdp.evaluate(`(() => {[...document.querySelectorAll("button.application-card")].find(item=>/团队网盘|Team Drive/i.test(item.innerText)).click();return true})()`);
  return cdp.wait(frame(`(() => {const error=document.querySelector("#error"),loading=document.querySelector("#loading"),roots=document.querySelectorAll("#root-list button").length;return{ready:loading?.hidden===true&&roots>=2&&!error?.textContent,roots,error:error?.textContent||null}})()`), `${label} Team Drive iframe`, 40000);
}

async function sessionIdentity(cdp) {
  const value = await browserJson(cdp, "/api/auth/session");
  requireValue(value.status === 200 && typeof value.value?.identity?.id === "string", "authenticated identity is unavailable");
  return value.value.identity.id;
}

async function selectRoot(cdp, scope, label) {
  const value = await browserJson(cdp, "/api/v1/files/bootstrap");
  const index = value.value?.data?.findIndex((item) => item.scope_kind === scope);
  requireValue(value.status === 200 && Number.isSafeInteger(index) && index >= 0, `${label} ${scope} root is unavailable`);
  await cdp.evaluate(frame(`document.querySelectorAll("#root-list button")[${index}].click(),true`));
  await cdp.wait(frame(`(() => ({ready:document.querySelector("#loading")?.hidden===true&&document.querySelectorAll("#root-list button")[${index}]?.classList.contains("is-active")&&!document.querySelector("#error")?.textContent}))()`), `${label} ${scope} root`);
  return value.value.data[index];
}

async function createFolder(cdp, name, label) {
  await cdp.evaluate(frame(`document.querySelector("#new-folder").click(),true`));
  await cdp.wait(frame(`({ready:document.querySelector("#text-dialog")?.open===true})`), `${label} folder dialog`);
  requireValue(await cdp.evaluate(frame(inputSetter("#dialog-input", name))), `${label} folder name input is missing`);
  await cdp.evaluate(frame(`document.querySelector("#text-form").requestSubmit(),true`));
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#text-dialog")?.open===false&&[...document.querySelectorAll("#file-list .file-copy strong")].some(item=>item.textContent===${JSON.stringify(name)}),error:document.querySelector("#dialog-error")?.textContent||document.querySelector("#error")?.textContent||null}))()`), `${label} folder creation`);
}

async function setFrameFile(cdp, selector, path, label) {
  const input = await cdp.evaluate(frame(`document.querySelector(${JSON.stringify(selector)})`), { byValue: false });
  requireValue(typeof input?.objectId === "string", `${label} file input is missing`);
  await cdp.send("DOM.setFileInputFiles", { files: [path], objectId: input.objectId });
}

async function waitEntry(cdp, name, label, timeout = 90000) {
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#loading")?.hidden===true&&[...document.querySelectorAll("#file-list .file-copy strong")].some(item=>item.textContent===${JSON.stringify(name)})&&!document.querySelector("#error")?.textContent,error:document.querySelector("#error")?.textContent||null}))()`), label, timeout);
}

async function waitEntryAbsent(cdp, name, label) {
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#loading")?.hidden===true&&![...document.querySelectorAll("#file-list .file-copy strong")].some(item=>item.textContent===${JSON.stringify(name)}),error:document.querySelector("#error")?.textContent||null}))()`), label);
}

async function openDetails(cdp, name, label) {
  const clicked = await cdp.evaluate(frame(`(() => {const row=[...document.querySelectorAll("#file-list article")].find(item=>item.querySelector(".file-copy strong")?.textContent===${JSON.stringify(name)});if(!row)return false;row.click();return true})()`));
  requireValue(clicked, `${label} entry is missing`);
  return cdp.wait(frame(`({ready:document.querySelector("#details")?.classList.contains("is-open")&&document.querySelector("#details-name")?.textContent===${JSON.stringify(name)}})`), `${label} details`);
}

async function clickDetailAction(cdp, pattern, label) {
  const clicked = await cdp.evaluate(frame(`(() => {const button=[...document.querySelectorAll("#details-actions button")].find(item=>${pattern}.test(item.textContent));if(!button)return false;button.click();return true})()`));
  requireValue(clicked, `${label} action is missing`);
}

async function uploadFile(cdp, path, name, label) {
  await setFrameFile(cdp, "#file-input", path, label);
  await waitEntry(cdp, name, `${label} upload`, 120000);
}

async function waitDownloaded(directory, before, expected, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const name of await readdir(directory)) {
      if (before.has(name) || name.endsWith(".crdownload")) continue;
      const bytes = await readFile(join(directory, name));
      if (bytes.equals(expected)) return true;
    }
    await sleep(100);
  }
  throw new BrowserSmokeError(`${label} download failed integrity validation`);
}

async function downloadSelected(cdp, directory, expected, label, timeout = 90000) {
  const before = new Set(await readdir(directory));
  await clickDetailAction(cdp, "/下载|Download/", label);
  return waitDownloaded(directory, before, expected, label, timeout);
}

async function previewSelected(cdp, expected, label) {
  await clickDetailAction(cdp, "/预览|Preview/", label);
  await cdp.wait(frame(`(() => ({ready:document.querySelector("#preview-dialog")?.open===true&&document.querySelector("#preview-body pre")?.textContent===${JSON.stringify(expected)},error:document.querySelector("#error")?.textContent||null}))()`), `${label} preview`);
  await cdp.evaluate(frame(`document.querySelector("#close-preview").click(),true`));
}

async function addVersion(cdp, path, expectedCount, label) {
  await cdp.evaluate(frame(`document.querySelector("#new-version").click(),true`));
  await setFrameFile(cdp, "#version-input", path, label);
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#upload-panel")?.hidden===true&&document.querySelectorAll("#version-list .version-row").length>=${expectedCount},count:document.querySelectorAll("#version-list .version-row").length,error:document.querySelector("#error")?.textContent||null}))()`), `${label} immutable version`, 120000);
}

async function editSelected(cdp, name, destinationName, label, actionPattern = "/重命名|Rename/") {
  await clickDetailAction(cdp, actionPattern, label);
  await cdp.wait(frame(`({ready:document.querySelector("#text-dialog")?.open===true})`), `${label} edit dialog`);
  requireValue(await cdp.evaluate(frame(inputSetter("#dialog-input", name))), `${label} edit input is missing`);
  const destinationNames = destinationName === "根目录" ? ["根目录", "Root"] : [destinationName];
  const destinationSelected = await cdp.evaluate(frame(`(() => {const names=${JSON.stringify(destinationNames)},select=document.querySelector("#dialog-parent"),option=[...select.options].find(item=>names.includes(item.textContent));if(!option)return false;select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));return true})()`));
  requireValue(destinationSelected, `${label} destination is unavailable`);
  await cdp.evaluate(frame(`document.querySelector("#text-form").requestSubmit(),true`));
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#text-dialog")?.open===false,error:document.querySelector("#dialog-error")?.textContent||document.querySelector("#error")?.textContent||null}))()`), `${label} edit completion`);
}

async function openFolder(cdp, name, label) {
  const opened = await cdp.evaluate(frame(`(() => {const row=[...document.querySelectorAll("#file-list article")].find(item=>item.querySelector(".file-copy strong")?.textContent===${JSON.stringify(name)});if(!row)return false;row.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));return true})()`));
  requireValue(opened, `${label} folder is missing`);
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#loading")?.hidden===true&&[...document.querySelectorAll("#breadcrumbs button")].at(-1)?.textContent===${JSON.stringify(name)},error:document.querySelector("#error")?.textContent||null}))()`), `${label} folder open`);
}

async function goRoot(cdp, label) {
  await cdp.evaluate(frame(`document.querySelector("#breadcrumbs button")?.click(),true`));
  return cdp.wait(frame(`({ready:document.querySelector("#loading")?.hidden===true&&document.querySelectorAll("#breadcrumbs button").length===1})`), `${label} root`);
}

async function search(cdp, query, expectedName, label) {
  requireValue(await cdp.evaluate(frame(inputSetter("#search", query))), `${label} search input is missing`);
  return cdp.wait(frame(`(() => ({ready:document.querySelector("#loading")?.hidden===true&&[...document.querySelectorAll("#file-list .file-copy strong")].some(item=>item.textContent===${JSON.stringify(expectedName)}),error:document.querySelector("#error")?.textContent||null}))()`), `${label} permission-scoped search`);
}

async function clearSearch(cdp, label) {
  requireValue(await cdp.evaluate(frame(inputSetter("#search", ""))), `${label} search clear failed`);
  return cdp.wait(frame(`({ready:document.querySelector("#loading")?.hidden===true})`), `${label} search reset`);
}

async function trashSelected(cdp, name, label) {
  await clickDetailAction(cdp, "/回收站|recycle bin/i", label);
  await cdp.wait(frame(`({ready:document.querySelector("#trash-dialog")?.open===true&&Boolean(document.querySelector("#trash-confirm")),error:document.querySelector("#error")?.textContent||null})`), `${label} trash confirmation`);
  await cdp.evaluate(frame(`document.querySelector("#trash-form").requestSubmit(),true`));
  return waitEntryAbsent(cdp, name, `${label} trash transition`);
}

async function openRecycle(cdp, expectedName, label) {
  await cdp.evaluate(frame(`document.querySelector('[data-view="recycle"]').click(),true`));
  return waitEntry(cdp, expectedName, `${label} recycle listing`);
}

async function restoreSelected(cdp, name, label) {
  await clickDetailAction(cdp, "/恢复|Restore/", label);
  return waitEntryAbsent(cdp, name, `${label} restore transition`);
}

async function shareSelected(cdp, memberIdentityId, entryId, label) {
  await clickDetailAction(cdp, "/共享|Share/", label);
  await cdp.wait(frame(`({ready:document.querySelector("#share-dialog")?.open===true})`), `${label} share dialog`);
  requireValue(await cdp.evaluate(frame(inputSetter("#share-principal", memberIdentityId))), `${label} share principal input is missing`);
  await cdp.evaluate(frame(`document.querySelector("#share-form").requestSubmit(),true`));
  await cdp.wait(frame(`(() => ({ready:document.querySelector("#share-dialog")?.open===false&&!document.querySelector("#share-error")?.textContent,error:document.querySelector("#share-error")?.textContent||null}))()`), `${label} share creation`);
  const value = await browserJson(cdp, `/api/v1/files/entries/${entryId}/shares`);
  const share = value.value?.data?.find((item) => item.principal_key === memberIdentityId && item.revoked_at === null);
  requireValue(value.status === 200 && typeof share?.id === "string", `${label} durable share fact is unavailable`);
  return share.id;
}

async function findEntry(cdp, rootId, query, exactName, label) {
  const value = await browserJson(cdp, `/api/v1/files/roots/${rootId}/search?q=${encodeURIComponent(query)}&limit=100`);
  const entry = value.value?.data?.find((item) => item.name === exactName);
  requireValue(value.status === 200 && typeof entry?.id === "string", `${label} file metadata is unavailable`);
  return entry;
}

async function cleanupAcceptanceEntries(cdp, roots, label, ownedRunId = null) {
  let activeFound = 0, topLevelTrashed = 0, sharesRevoked = 0;
  for (const root of roots) {
    const found = await browserJson(cdp, `/api/v1/files/roots/${root.id}/search?q=team-drive-browser&limit=200`);
    requireValue(found.status === 200 && Array.isArray(found.value?.data), `${label} acceptance cleanup search failed`);
    const matches = found.value.data.filter((entry) => ACCEPTANCE_ENTRY.test(entry.name)
      && (ownedRunId === null || entry.name.startsWith(`${ownedRunId}-`)) && entry.trashed_at === null);
    activeFound += matches.length;
    const ids = new Set(matches.map((entry) => entry.id));
    const topLevel = matches.filter((entry) => !entry.parent_id || !ids.has(entry.parent_id));
    for (const entry of topLevel) {
      const shares = await browserJson(cdp, `/api/v1/files/entries/${entry.id}/shares`);
      if (shares.status === 200 && Array.isArray(shares.value?.data)) {
        for (const share of shares.value.data.filter((item) => item.revoked_at === null)) {
          const revoked = await browserJson(cdp, `/api/v1/files/shares/${share.id}`, { method: "DELETE", body: {} });
          requireValue(revoked.status === 200, `${label} acceptance share cleanup failed`);
          sharesRevoked += 1;
        }
      } else {
        requireValue(entry.kind === "folder" && shares.status === 200, `${label} acceptance share inventory failed`);
      }
      const trashed = await browserJson(cdp, `/api/v1/files/entries/${entry.id}/trash`, { method: "POST", body: { expected_revision: entry.revision } });
      requireValue(trashed.status === 200, `${label} acceptance entry cleanup failed`);
      topLevelTrashed += 1;
    }
    const remaining = await browserJson(cdp, `/api/v1/files/roots/${root.id}/search?q=team-drive-browser&limit=200`);
    requireValue(remaining.status === 200 && Array.isArray(remaining.value?.data)
      && remaining.value.data.every((entry) => !ACCEPTANCE_ENTRY.test(entry.name)
        || (ownedRunId !== null && !entry.name.startsWith(`${ownedRunId}-`))), `${label} left active acceptance entries behind`);
  }
  return { activeFound, topLevelTrashed, sharesRevoked, activeRemaining: 0 };
}

async function verifyMemberShareDenial(cdp, folderName, ownerIdentityId) {
  await openDetails(cdp, folderName, "member folder");
  await clickDetailAction(cdp, "/共享|Share/", "member share");
  await cdp.wait(frame(`({ready:document.querySelector("#share-dialog")?.open===true})`), "member share dialog");
  requireValue(await cdp.evaluate(frame(inputSetter("#share-principal", ownerIdentityId))), "member share principal input is missing");
  await cdp.evaluate(frame(`document.querySelector("#share-form").requestSubmit(),true`));
  return cdp.wait(frame(`(() => {const error=document.querySelector("#share-error");return{ready:Boolean(error&&!error.hidden&&error.textContent),message:error?.textContent||null,locale:document.documentElement.lang}})()`), "member share authorization denial");
}

async function screenshot(cdp, directory, key) {
  const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(captured.data, "base64");
  requireValue(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "browser screenshot is not PNG");
  const path = join(directory, `${key}.png`); await writeFile(path, bytes, { flag: "wx" });
  return { path: relative(ROOT, path), digest: digest(bytes) };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new BrowserSmokeError("browser smoke evidence already exists; use a new run ID"); }).catch((error) => { if (error instanceof BrowserSmokeError) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  let webImageId;
  if (deployment.runnerId === "teamaibox.current-owner-recovery-deployment.v1") {
    webImageId = deployment.runtime?.web?.imageId;
    requireValue(deployment.status === "passed" && SHA256.test(webImageId ?? ""), "browser smoke current deployment binding is invalid");
  } else if (deployment.runnerId === "teamaibox.current-web-successor.v1") {
    webImageId = deployment.image?.imageId;
    requireValue(deployment.status === "passed" && deployment.runtime?.canonicalWeb?.imageId === webImageId
      && deployment.runtime?.standardWeb?.imageId === webImageId && SHA256.test(webImageId ?? ""),
      "browser smoke current Web successor binding is invalid");
  } else if (deployment.runnerId === "teamaibox.current-browser-runtime-qualification.v1") {
    webImageId = deployment.images?.web?.imageId;
    requireValue(deployment.status === "passed" && deployment.components?.canonicalWeb?.imageId === webImageId
      && deployment.components?.standardWeb?.imageId === webImageId && SHA256.test(webImageId ?? ""),
      "browser smoke current browser runtime binding is invalid");
  } else {
    const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/);
    requireValue(identity, "browser smoke deployment identity is invalid");
    const deploymentPlan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
    const drive = deployment.imageBindings?.find((item) => item.component === "catalog-team-drive");
    const web = deployment.imageBindings?.find((item) => item.component === "catalog-web");
    webImageId = web?.imageId ?? deploymentPlan.environment?.TEAMAIBOX_CATALOG_WEB_IMAGE;
    requireValue(deployment.status === "passed" && SHA256.test(drive?.imageId ?? "") && SHA256.test(webImageId ?? ""), "browser smoke deployment binding is invalid");
  }
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(join(tmpdir(), "teamaibox-team-drive-browser-")), downloads = join(profile, "downloads"); await mkdir(downloads);
  const firstName = `${options.runId}-document.txt`, firstContent = `team-drive-browser:${options.runId}:v1`, firstPath = join(profile, firstName); await writeFile(firstPath, firstContent);
  const secondContent = `team-drive-browser:${options.runId}:v2`, secondPath = join(profile, `${options.runId}-v2.txt`); await writeFile(secondPath, secondContent);
  const privateName = `${options.runId}-private.txt`, privateContent = `team-drive-private:${options.runId}`, privatePath = join(profile, privateName); await writeFile(privatePath, privateContent);
  const largeName = `${options.runId}-large.bin`, largeBytes = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61), largePath = join(profile, largeName); await writeFile(largePath, largeBytes);
  const folderName = `${options.runId}-destination`, renamedName = `${options.runId}-renamed.txt`, copyName = `${options.runId}-copy.txt`, memberFolder = `${options.runId}-member-folder`;
  const port = await freePort(), chrome = spawn(options.chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--ignore-certificate-errors", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = new Date().toISOString(), accountEvidence = [], operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), consoleErrors = [];
  let cdp, browser = null, failure = null, resumeLookups = 0;
  const cleanup = { stale: null, current: null, recycleRetentionPreserved: true };
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`), target = targets.find((item) => item.type === "page"); requireValue(target?.webSocketDebuggerUrl, "Chrome page target is unavailable");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") consoleErrors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"), cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true }), cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })]);
    browser = await cdp.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform})`);

    await signIn(cdp, options.origin, accounts.member); const memberIdentityId = await sessionIdentity(cdp);
    await signIn(cdp, options.origin, accounts.owner); const ownerIdentityId = await sessionIdentity(cdp); const ownerOpen = await openTeamDrive(cdp, "owner");
    const ownerBootstrap = await browserJson(cdp, "/api/v1/files/bootstrap");
    requireValue(ownerBootstrap.status === 200 && Array.isArray(ownerBootstrap.value?.data) && ownerBootstrap.value.data.length >= 2, "owner cleanup roots are unavailable");
    cleanup.stale = await cleanupAcceptanceEntries(cdp, ownerBootstrap.value.data, "pre-run");
    const teamRoot = await selectRoot(cdp, "team", "owner");
    await createFolder(cdp, folderName, "owner"); operations.folderCreated = true;
    await uploadFile(cdp, firstPath, firstName, "owner small file"); operations.smallFileUploaded = true;
    await openDetails(cdp, firstName, "owner small file"); await downloadSelected(cdp, downloads, Buffer.from(firstContent), "owner small file"); operations.downloadIntegrity = true;
    await previewSelected(cdp, firstContent, "owner small file"); operations.previewed = true;
    await addVersion(cdp, secondPath, 2, "owner small file"); operations.versionAdded = true; operations.versionHistory = true;
    await previewSelected(cdp, secondContent, "owner latest version");
    await editSelected(cdp, renamedName, folderName, "owner rename and move"); operations.renamed = true; operations.moved = true;
    await openFolder(cdp, folderName, "owner destination"); await waitEntry(cdp, renamedName, "owner moved file"); await openDetails(cdp, renamedName, "owner moved file");
    await editSelected(cdp, copyName, "根目录", "owner version-preserving copy", "/复制|Copy/"); await goRoot(cdp, "owner"); await waitEntry(cdp, copyName, "owner copied file");
    await openDetails(cdp, copyName, "owner copied file"); const copiedVersions = await cdp.wait(frame(`({ready:document.querySelectorAll("#version-list .version-row").length>=2,count:document.querySelectorAll("#version-list .version-row").length})`), "owner copied version history"); requireValue(copiedVersions.count >= 2, "copied version history drifted"); operations.copiedWithVersions = true;
    await cdp.evaluate(frame(`document.querySelector("#close-details").click(),true`)); await search(cdp, copyName, copyName, "owner"); operations.searched = true;
    const quota = await cdp.evaluate(frame(`({label:document.querySelector("#quota-label")?.textContent,detail:document.querySelector("#quota-detail")?.textContent})`)); requireValue(quota.label && quota.label !== "—" && quota.detail && quota.detail !== "—", "owner quota is unavailable"); operations.quotaVisible = true;
    await openDetails(cdp, copyName, "owner copied file"); await trashSelected(cdp, copyName, "owner copied file"); operations.trashed = true;
    await openRecycle(cdp, copyName, "owner"); await openDetails(cdp, copyName, "owner recycled file"); await restoreSelected(cdp, copyName, "owner recycled file"); operations.restored = true;

    const personalRoot = await selectRoot(cdp, "user", "owner"); await uploadFile(cdp, privatePath, privateName, "owner private file");
    const privateEntry = await findEntry(cdp, personalRoot.id, privateName, privateName, "owner private"); await openDetails(cdp, privateName, "owner private file");
    const shareId = await shareSelected(cdp, memberIdentityId, privateEntry.id, "owner private file"); operations.shareCreated = true;

    await selectRoot(cdp, "team", "owner");
    requireValue(await cdp.evaluate(frame(`(() => {const panel=document.querySelector("#upload-panel"),detail=document.querySelector("#upload-detail"),percent=document.querySelector("#upload-percent"),cancel=document.querySelector("#cancel-upload");if(!panel||!detail||!percent||!cancel)return false;document.documentElement.dataset.acceptanceInterrupted="";const observe=()=>{const text=detail.textContent||"";if((text.includes("分片 1/3")||text.includes("Part 1/3"))&&Number.parseFloat(percent.textContent)>=30){cancel.click();document.documentElement.dataset.acceptanceInterrupted="1";observer.disconnect()}};const observer=new MutationObserver(observe);observer.observe(panel,{childList:true,subtree:true,characterData:true});observe();return true})()`)), "multipart UI interruption observer is unavailable");
    await setFrameFile(cdp, "#file-input", largePath, "owner large file");
    await sleep(20000);
    {
      const previous = cdp;
      cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
      cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") consoleErrors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
      await Promise.all([
        cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"),
        cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true }),
        cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }),
      ]);
      previous.close();
    }
    const interrupted = await cdp.wait(frame(`(() => {const storage=document.defaultView.localStorage,records=Object.keys(storage).filter(key=>key.startsWith("teamaibox.team-drive.upload.v1:")).map(key=>JSON.parse(storage.getItem(key)));return{ready:document.documentElement.dataset.acceptanceInterrupted==="1"&&records.length===1&&Object.keys(records[0].parts||{}).includes("1"),recordCount:records.length,completedParts:records[0]?Object.keys(records[0].parts||{}):[]}})()`), "multipart first-part UI interruption", 180000);
    requireValue(interrupted.recordCount === 1 && interrupted.completedParts.includes("1"), "multipart resume metadata is incomplete"); operations.multipartInterrupted = true;
    await cdp.wait(frame(`({ready:document.querySelector("#upload-panel")?.hidden===true})`), "owner interrupted multipart UI settled", 30000);
    const resumeLookupsBefore = await cdp.evaluate(frame(`[...document.defaultView.performance.getEntriesByType("resource")].filter(item=>{const path=new URL(item.name).pathname,parts=path.split("/");return parts.length===7&&parts.slice(1,5).join("/")==="api/v1/objects/multipart"&&parts[6]==="parts"}).length`));
    await setFrameFile(cdp, "#file-input", largePath, "owner resumable large file");
    await sleep(30000);
    {
      const previous = cdp;
      cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "browser exception").slice(0, 300)));
      cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") consoleErrors.push(String(event.args?.[0]?.value ?? "console error").slice(0, 300)); });
      await Promise.all([
        cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("DOM.enable"),
        cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true }),
        cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }),
      ]);
      previous.close();
    }
    await waitEntry(cdp, largeName, "owner resumed large upload", 240000);
    resumeLookups = await cdp.evaluate(frame(`[...document.defaultView.performance.getEntriesByType("resource")].filter(item=>{const path=new URL(item.name).pathname,parts=path.split("/");return parts.length===7&&parts.slice(1,5).join("/")==="api/v1/objects/multipart"&&parts[6]==="parts"}).length`));
    requireValue(resumeLookups > resumeLookupsBefore, "multipart upload did not query server-authoritative resume state"); operations.multipartResumed = true;
    await openDetails(cdp, largeName, "owner large file"); await downloadSelected(cdp, downloads, largeBytes, "owner large file", 180000); operations.largeFileDownloadIntegrity = true;
    const ownerScreenshot = await screenshot(cdp, options.screenshots, "owner");
    accountEvidence.push({ key: "owner", role: "owner", launchable: true, iframeLoaded: true, rootCount: ownerOpen.roots, folderCreated: true, screenshot: ownerScreenshot });

    for (const name of await readdir(downloads)) await rm(join(downloads, name), { force: true });
    await signIn(cdp, options.origin, accounts.member);
    const shared = await browserJson(cdp, `/api/v1/files/shared/${shareId}`); requireValue(shared.status === 200 && shared.value?.entry?.id === privateEntry.id, "member cannot resolve the shared private file"); operations.shareRecipientAccess = true;
    const grant = await browserJson(cdp, `/api/v1/files/entries/${privateEntry.id}/download`); requireValue(grant.status === 200 && typeof grant.value?.reference_id === "string", "member shared download grant failed");
    const sharedContent = await cdp.evaluate(`fetch(${JSON.stringify(`/api/v1/objects/references/${grant.value.reference_id}/content?download=1`)},{credentials:"same-origin"}).then(async r=>({status:r.status,text:await r.text()}))`);
    requireValue(sharedContent.status === 200 && sharedContent.text === privateContent, "member shared content integrity drifted"); operations.shareRecipientDownloadIntegrity = true;
    const denied = await browserJson(cdp, `/api/v1/files/entries/${privateEntry.id}/trash`, { method: "POST", body: { expected_revision: shared.value.entry.revision } }); requireValue(denied.status === 404, "viewer mutation did not fail closed"); operations.unauthorizedMutationDenied = true;
    const memberOpen = await openTeamDrive(cdp, "member"); await selectRoot(cdp, "team", "member"); await createFolder(cdp, memberFolder, "member");
    const shareDenied = await verifyMemberShareDenial(cdp, memberFolder, ownerIdentityId);
    const localizedDenial = shareDenied.locale === "zh-CN"
      ? /[㐀-鿿]/u.test(shareDenied.message) && !/You do not have permission/i.test(shareDenied.message)
      : shareDenied.locale === "en" && /You do not have permission to perform this operation\./i.test(shareDenied.message) && !/[㐀-鿿]/u.test(shareDenied.message);
    requireValue(localizedDenial, "member share denial is not localized for the active account preference"); operations.memberShareDenied = true; operations.memberShareDenialLocalized = true;
    const memberScreenshot = await screenshot(cdp, options.screenshots, "ordinary-user");
    accountEvidence.push({ key: "ordinary-user", role: "member", launchable: true, iframeLoaded: true, rootCount: memberOpen.roots, folderCreated: true, screenshot: memberScreenshot });
    requireValue(OPERATION_KEYS.every((key) => operations[key] === true), "Team Drive operation matrix is incomplete");
    requireValue(consoleErrors.length === 0, `browser emitted ${consoleErrors.length} error events`);
    await signIn(cdp, options.origin, accounts.owner);
    const cleanupBootstrap = await browserJson(cdp, "/api/v1/files/bootstrap");
    requireValue(cleanupBootstrap.status === 200 && Array.isArray(cleanupBootstrap.value?.data), "post-run cleanup roots are unavailable");
    cleanup.current = await cleanupAcceptanceEntries(cdp, cleanupBootstrap.value.data, "post-run", options.runId);
    requireValue(cleanup.current.activeFound >= 5 && cleanup.current.activeRemaining === 0, "post-run acceptance cleanup is incomplete");
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    if (failure && cdp) {
      try {
        await signIn(cdp, options.origin, accounts.owner);
        const failedBootstrap = await browserJson(cdp, "/api/v1/files/bootstrap");
        requireValue(failedBootstrap.status === 200 && Array.isArray(failedBootstrap.value?.data), "failed-run cleanup roots are unavailable");
        cleanup.current = await cleanupAcceptanceEntries(cdp, failedBootstrap.value.data, "failed-run", options.runId);
      } catch (cleanupError) {
        failure.cleanup = String(cleanupError?.message ?? cleanupError).slice(0, 240);
      }
    }
    cdp?.close(); chrome.kill("SIGTERM"); await Promise.race([new Promise((resolvePromise) => chrome.once("exit", resolvePromise)), sleep(3000)]);
    largeBytes.fill(0); await rm(profile, { recursive: true, force: true }); accounts.owner.value.password = accounts.member.value.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 3, runnerId: "teamaibox.team-drive-browser-acceptance.v3", runId: options.runId, featureKey: "official.team-drive", status: failure ? "failed" : "passed", origin: options.origin,
    startedAt, completedAt: new Date().toISOString(), browser, accounts: accountEvidence, operations, console: { errorCount: consoleErrors.length }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))) },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId },
    cleanup, credentialsRetained: false, contentRetained: false, commandOutputRetained: false, failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new BrowserSmokeError(`Team Drive browser acceptance failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, accountCount: accountEvidence.length, operationCount: OPERATION_KEYS.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Team Drive browser acceptance failed"}\n`); process.exitCode = 1; });
