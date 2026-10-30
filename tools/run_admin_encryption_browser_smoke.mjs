#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { CHROME, canonical, credentialsFromStdin, digest, need, setPreferences, shotElement, signIn, startChrome, stopChrome } from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-encryption-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  "realDeploymentBound", "ownerStatusApiPassed", "verifiedLuksVisible", "defaultOffVisible",
  "transitionUnavailableVisible", "webUnavailableVisible", "hardwareKeyAbsent", "readinessFailClosed",
  "enableDisabled", "credentialsAndFactorsNotRendered", "prepareApiDenied", "stateUnchanged", "reloadRetained",
  "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied",
  "memberDirectRouteDenied",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Encryption browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Encryption browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Encryption browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Encryption browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]),
    output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Encryption browser artifact escapes the repository");
  }
  return result;
}

async function openEncryption(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/encryption", origin).href });
  return cdp.wait(`(() => ({ready:Boolean(document.querySelector(".encryption-panel .encryption-summary")&&!document.querySelector(".encryption-state--error")),error:document.querySelector(".encryption-state--error")?.textContent||null}))()`, "Encryption administration", 60_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Encryption browser evidence exists; use a new run ID"); })
    .catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.encryption"
    && [images["catalog-web"], images["catalog-platform-api"], images["catalog-object-service"]].every((item) => SHA256.test(item ?? "")), "Admin Encryption deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Encryption origin differs from deployment plan");
  const health = new Set((plan.healthChecks ?? []).map((item) => item.key)), retained = new Set((plan.retainedStateChecks ?? []).map((item) => item.key));
  need(health.has("storage-encrypted-pool-journey") && health.has("admin-encryption-status-and-fail-closed")
    && retained.has("admin-encryption-post-restart") && retained.has("storage-ciphertext-only"), "Admin Encryption deployment lacks LUKS2, fail-closed, restart, or ciphertext proof");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime;
    operations.realDeploymentBound = true;
    await signIn(cdp, options.origin, accounts.owner); await openEncryption(cdp, options.origin);
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const owner = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),value=await response.json(),panel=document.querySelector(".encryption-panel"),summary=[...document.querySelectorAll(".encryption-summary article")].map(item=>item.innerText),modes=[...document.querySelectorAll(".encryption-mode")],prerequisites=[...document.querySelectorAll(".encryption-prerequisite")],inputs=[...document.querySelectorAll(".encryption-enable input")];return{status:response.status,value,summary,panelText:panel?.innerText||"",modeCount:modes.length,modesDisabled:modes.every(item=>item.disabled),prerequisiteCount:prerequisites.length,unavailableCount:document.querySelectorAll(".encryption-prerequisite--unavailable").length,enableDisabled:document.querySelector(".encryption-enable .primary-button")?.disabled===true,inputValues:inputs.map(item=>item.value),commitVisible:Boolean(document.querySelector(".encryption-commit"))}})()`);
    operations.ownerStatusApiPassed = owner.status === 200 && owner.value?.schemaVersion === 1;
    operations.verifiedLuksVisible = owner.value?.blockEncryption?.configured === true && owner.value?.blockEncryption?.mode === "luks2"
      && owner.value?.blockEncryption?.status === "verified" && /LUKS2 已验证/.test(owner.panelText);
    operations.defaultOffVisible = owner.value?.startupProtection?.enabled === false && owner.value?.startupProtection?.mode === "automatic" && /默认关闭/.test(owner.panelText);
    operations.transitionUnavailableVisible = owner.value?.capabilities?.transition === false && /未配置/.test(owner.panelText);
    operations.webUnavailableVisible = owner.value?.capabilities?.webPassphrase === false && /Web 解锁运行时尚未配置/.test(owner.panelText);
    operations.hardwareKeyAbsent = !Object.hasOwn(owner.value?.capabilities ?? {}, "usbKey") && !/USB Key SDK/.test(owner.panelText);
    operations.readinessFailClosed = owner.prerequisiteCount === 5 && owner.unavailableCount === 5
      && owner.value?.prerequisites?.every((item) => item.state === "unavailable");
    operations.enableDisabled = owner.modeCount === 2 && owner.modesDisabled && owner.enableDisabled;
    operations.credentialsAndFactorsNotRendered = owner.inputValues.every((item) => item === "") && owner.commitVisible === false
      && !/018f0000-0000-7000-8000/.test(owner.panelText);
    need(["ownerStatusApiPassed", "verifiedLuksVisible", "defaultOffVisible", "transitionUnavailableVisible", "webUnavailableVisible",
      "hardwareKeyAbsent", "readinessFailClosed", "enableDisabled", "credentialsAndFactorsNotRendered"].every((key) => operations[key]), "owner Encryption page did not show the exact safe state");
    const denied = await cdp.evaluate(`(async()=>{const token=decodeURIComponent((document.cookie.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-teamaibox-csrf="))||"=").split("=").slice(1).join("=")),response=await fetch("/api/v1/admin/encryption/protection/enable",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json","x-csrf-token":token},body:JSON.stringify({phase:"prepare",mode:"web_passphrase",recovery_verification_id:"018f0000-0000-7000-8000-000000000011",selected_verification_id:"018f0000-0000-7000-8000-000000000012",request_id:"018f0000-0000-7000-8000-000000000013",confirmation:"PREPARE WEB PASSPHRASE"})}),failure=await response.json(),afterResponse=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),after=await afterResponse.json();return{status:response.status,code:failure?.error?.code,afterStatus:afterResponse.status,after}})()`);
    operations.prepareApiDenied = denied.status === 503 && denied.code === "encryption_transition_unavailable";
    operations.stateUnchanged = denied.afterStatus === 200 && denied.after?.startupProtection?.enabled === false
      && denied.after?.startupProtection?.mode === "automatic" && denied.after?.latestTransition === null && denied.after?.recentTransitions?.length === 0;
    need(operations.prepareApiDenied && operations.stateUnchanged, "browser prepare did not fail closed or changed startup protection");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-desktop-zh-dark", ".encryption-panel"));
    await cdp.send("Page.reload", { ignoreCache: false }); await openEncryption(cdp, options.origin);
    operations.reloadRetained = await cdp.evaluate(`(() => {const p=document.querySelector(".encryption-panel")?.innerText||"";return /LUKS2 已验证/.test(p)&&/默认关闭/.test(p)&&/未配置/.test(p)})()`);
    need(operations.reloadRetained, "safe Encryption state did not survive reload");
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    need(await cdp.evaluate(`(() => {const p=document.querySelector(".encryption-panel")?.innerText||"";return /LUKS2 verified/.test(p)&&/Off by default/.test(p)&&/Not configured/.test(p)})()`), "English Encryption state is incomplete");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-desktop-en-light", ".encryption-panel"));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openEncryption(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,summary:document.querySelectorAll(".encryption-summary article").length,prerequisites:document.querySelectorAll(".encryption-prerequisite").length})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.summary === 3 && mobile.prerequisites === 5;
    need(operations.mobileNoOverflow, "mobile Encryption layout overflowed or lost state");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".encryption-panel"));
    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/encryption", options.origin).href });
    await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member direct Encryption denial");
    const member = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".encryption-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page),status:response.status}})()`);
    operations.memberAdminHidden = member.adminNav === false; operations.memberApiDenied = member.status === 403;
    operations.memberDirectRouteDenied = member.panel === false && member.denial && !member.ownerClaim && member.memberClaim;
    need(operations.memberAdminHidden && operations.memberApiDenied && operations.memberDirectRouteDenied, "ordinary member gained Encryption administration access or misleading identity");
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Encryption browser operations did not pass");
    need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-encryption-browser-smoke.v1", runId: options.runId,
    featureKey: "admin.encryption", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(),
    browser: runtime?.browser ?? null, operations, screenshots, console: { errorCount: runtime?.errors.length ?? 0 },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId,
      webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], objectServiceImageId: images["catalog-object-service"] },
    privacy: { credentialsRetained: false, factorMaterialRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true },
    limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed",
      activeMediaMigration: "not_performed_disposable_regular_file_luks2_only", hardwareKey: "retired_not_required",
      startupProtectionMutation: "not_available_fail_closed_status_only" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Encryption browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length,
    screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Encryption browser smoke failed"}\n`); process.exitCode = 1; });
