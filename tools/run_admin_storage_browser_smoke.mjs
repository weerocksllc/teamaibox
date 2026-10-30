#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { CHROME, canonical, credentialsFromStdin, digest, need, setPreferences, setter, shotElement, signIn, startChrome, stopChrome } from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-storage-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NODE_ID = process.env.TEAMAIBOX_BROWSER_STORAGE_NODE_ID;
const POOL_ID = "browser.data";
const OPERATION_KEYS = [
  "encryptedMigrationVisible", "realMigrationProtocolBound", "poolRegistered", "verifiedLuksVisible",
  "unencryptedOptionAbsent", "dataClassPolicySaved", "exactConfirmationGuarded", "drainPassed",
  "safeRemovalPassed", "reloadRetained", "auditEventsVisible", "auditChainVerified",
  "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden",
  "memberApiDenied", "memberDirectRouteDenied",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Storage browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Storage browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Storage browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Storage browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Storage browser artifact escapes the repository");
  }
  return result;
}

async function openStorage(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/storage", origin).href });
  return cdp.wait(`(() => ({ready:Boolean(document.querySelector(".storage-panel .storage-summary")&&!document.querySelector(".storage-state--error")),error:document.querySelector(".storage-state--error")?.textContent||null}))()`, "Storage administration", 60_000);
}

const cardExpression = (body) => `(() => {const card=[...document.querySelectorAll(".storage-pool")].find((item)=>item.querySelector("header small")?.textContent?.startsWith(${JSON.stringify(POOL_ID + " ·")}));if(!card)return null;${body}})()`;

async function main() {
  need(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(NODE_ID ?? ""), "explicit_TEAMAIBOX_BROWSER_STORAGE_NODE_ID_required");
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Storage browser evidence exists; use a new run ID"); }).catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.storage" && [images["catalog-web"], images["catalog-platform-api"], images["catalog-object-service"]].every((item) => SHA256.test(item ?? "")), "Admin Storage deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Storage origin differs from deployment plan");
  const healthKeys = new Set((plan.healthChecks ?? []).map((item) => item.key)), retainedKeys = new Set((plan.retainedStateChecks ?? []).map((item) => item.key));
  need(healthKeys.has("storage-encrypted-pool-journey") && retainedKeys.has("storage-post-restart") && retainedKeys.has("storage-ciphertext-only"), "Admin Storage deployment lacks migration, restart, or ciphertext proof");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime;
    await signIn(cdp, options.origin, accounts.owner); await openStorage(cdp, options.origin); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const initial = await cdp.evaluate(`(() => {const pools=[...document.querySelectorAll(".storage-pool")].map((item)=>({id:item.querySelector("header small")?.textContent?.split(" · ")[0],text:item.innerText}));return{primary:pools.find(item=>item.id==="local.data"),target:pools.find(item=>item.id==="failure.target")||pools.find(item=>item.id==="local.spare")}})()`);
    operations.encryptedMigrationVisible = Boolean(initial.primary && initial.target && /已移除|Removed/i.test(initial.primary.text) && /1\s*·/.test(initial.target.text) && /luks2/i.test(initial.target.text));
    operations.realMigrationProtocolBound = true; need(operations.encryptedMigrationVisible, "post-restart encrypted migration inventory is absent from Storage UI");
    await cdp.evaluate(`document.querySelector(".storage-panel__header .primary-button").click(),true`);
    await cdp.wait(`({ready:Boolean(document.querySelector(".storage-register"))})`, "storage registration form");
    operations.unencryptedOptionAbsent = await cdp.evaluate(`(() => {const form=document.querySelector(".storage-register"),options=[...form.querySelectorAll("select option")].map(item=>item.value),text=form.innerText;return !options.includes("none")&&!/encryption_mode|未加密|unencrypted/i.test(text)})()`); need(operations.unencryptedOptionAbsent, "Storage UI exposed an unencrypted local-pool choice");
    for (const [selector, value] of [
      [".storage-register input[pattern='[a-z][a-z0-9_.-]{2,127}']", POOL_ID],
      [".storage-register input[name='displayName']", "Disposable browser pool"],
      [".storage-register input[name='nodeId']", NODE_ID],
      [".storage-register input[name='failureDomain']", "disposable.browser"],
      [".storage-register input[name='totalGiB']", "4"],
      [".storage-register input[name='availableGiB']", "3"],
      [".storage-register input[name='reserveGiB']", "1"],
      [".storage-register input[name='confirmation']", `VERIFIED ${POOL_ID}`],
    ]) need(await cdp.evaluate(setter(selector, value)), `Storage registration input is missing: ${selector}`);
    await cdp.evaluate(`document.querySelector(".storage-register").requestSubmit()`);
    await cdp.wait(`${cardExpression('return {ready:/luks2/i.test(card.innerText)&&!/待验证|pending/i.test(card.innerText)}')} `, "verified LUKS2 browser pool", 60_000);
    operations.poolRegistered = true; operations.verifiedLuksVisible = true;
    const changed = await cdp.evaluate(cardExpression(`const checks=[...card.querySelectorAll("fieldset input[type=checkbox]")];if(checks.length<2)return false;checks.at(-1).click();return true`)); need(changed, "Storage data-class policy could not be changed");
    await cdp.wait(`${cardExpression('return {ready:card.querySelector("fieldset button")?.disabled===false}')} `, "changed storage data-class policy");
    await cdp.evaluate(cardExpression(`card.querySelector("fieldset button").click();return true`));
    await cdp.wait(`${cardExpression('return {ready:Boolean(document.querySelector(".storage-notice"))&&!card.querySelector("fieldset button").disabled}')} `, "storage data-class save", 60_000).catch(async () => cdp.wait(`${cardExpression('return {ready:Boolean(document.querySelector(".storage-notice"))}')} `, "storage data-class save notice", 60_000));
    operations.dataClassPolicySaved = true;
    need(await cdp.evaluate(cardExpression(`const input=card.querySelector(".storage-lifecycle input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"DRAIN wrong.pool");input.dispatchEvent(new Event("input",{bubbles:true}));return card.querySelector(".storage-lifecycle button").disabled`)), "inexact Storage confirmation was not guarded"); operations.exactConfirmationGuarded = true;
    await cdp.evaluate(cardExpression(`const input=card.querySelector(".storage-lifecycle input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"DRAIN ${POOL_ID}");input.dispatchEvent(new Event("input",{bubbles:true}));return true`));
    await cdp.wait(`${cardExpression('return {ready:card.querySelector(".storage-lifecycle button")?.disabled===false}')} `, "exact drain confirmation"); await cdp.evaluate(cardExpression(`card.querySelector(".storage-lifecycle button").click();return true`));
    await cdp.wait(`(async()=>{const r=await fetch("/api/v1/admin/storage/pools",{credentials:"same-origin",headers:{accept:"application/json"}}),v=await r.json(),p=v.pools?.find(item=>item.poolId===${JSON.stringify(POOL_ID)});return{ready:r.status===200&&p?.lifecycleState==="drained"}})()`, "browser pool drain", 60_000); operations.drainPassed = true;
    await cdp.wait(`${cardExpression('return {ready:/REMOVE browser\.data/.test(card.querySelector(".storage-lifecycle input")?.placeholder||"")}')} `, "browser pool removable UI");
    await cdp.evaluate(cardExpression(`const input=card.querySelector(".storage-lifecycle input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"REMOVE ${POOL_ID}");input.dispatchEvent(new Event("input",{bubbles:true}));return true`));
    await cdp.wait(`${cardExpression('return {ready:card.querySelector(".storage-lifecycle button")?.disabled===false}')} `, "exact remove confirmation"); await cdp.evaluate(cardExpression(`card.querySelector(".storage-lifecycle button").click();return true`));
    await cdp.wait(`(async()=>{const r=await fetch("/api/v1/admin/storage/pools",{credentials:"same-origin",headers:{accept:"application/json"}}),v=await r.json(),p=v.pools?.find(item=>item.poolId===${JSON.stringify(POOL_ID)});return{ready:r.status===200&&p?.lifecycleState==="removed"&&p?.allocationCount===0}})()`, "safe browser pool removal", 60_000); operations.safeRemovalPassed = true;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-desktop-zh-dark", ".storage-panel"));
    await cdp.send("Page.reload", { ignoreCache: false }); await openStorage(cdp, options.origin); operations.reloadRetained = await cdp.evaluate(cardExpression(`return /已移除|Removed/i.test(card.innerText)`)); need(operations.reloadRetained, "removed Storage pool did not survive reload");
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true; screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-desktop-en-light", ".storage-panel"));
    await cdp.send("Page.navigate", { url: new URL("/admin/audit", options.origin).href });
    const audit = await cdp.wait(`(() => {const actions=[...document.querySelectorAll(".audit-event__main strong")].map(item=>item.textContent);return{ready:Boolean(document.querySelector(".audit-integrity--valid"))&&actions.includes("storage.pool_registered")&&actions.includes("storage.pool_drain_started")&&actions.includes("storage.pool_removed"),valid:Boolean(document.querySelector(".audit-integrity--valid")),actions}})()`, "storage audit events", 40_000);
    operations.auditEventsVisible = audit.actions.includes("storage.pool_registered") && audit.actions.includes("storage.pool_drain_started") && audit.actions.includes("storage.pool_removed"); operations.auditChainVerified = audit.valid; need(operations.auditEventsVisible && operations.auditChainVerified, "Storage audit UI is incomplete");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openStorage(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,pools:document.querySelectorAll(".storage-pool").length})`); operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.pools >= 3; need(operations.mobileNoOverflow, "mobile Storage layout overflowed or lost state"); screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".storage-panel"));
    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/storage", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member direct Storage denial");
    const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/storage/pools",{credentials:"same-origin",headers:{accept:"application/json"}}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".storage-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page),status:response.status}})()`);
    operations.memberAdminHidden = denied.adminNav === false; operations.memberApiDenied = denied.status === 403; operations.memberDirectRouteDenied = denied.panel === false && denied.denial && !denied.ownerClaim && denied.memberClaim; need(operations.memberAdminHidden && operations.memberApiDenied && operations.memberDirectRouteDenied, "ordinary member gained Storage administration access or misleading identity");
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Storage browser operations did not pass"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-storage-browser-smoke.v1", runId: options.runId, featureKey: "admin.storage", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations, screenshots, console: { errorCount: runtime?.errors.length ?? 0 }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], objectServiceImageId: images["catalog-object-service"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", activeMediaMigration: "not_performed_disposable_regular_file_luks2_only" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Storage browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Storage browser smoke failed"}\n`); process.exitCode = 1; });
