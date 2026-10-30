#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { CHROME, canonical, credentialsFromStdin, digest, need, setPreferences, setter, shotElement, signIn, startChrome, stopChrome } from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-encryption-transition-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECOVERY_TICKET = "018f0000-0000-7000-8000-000000000021";
const WEB_TICKET = "018f0000-0000-7000-8000-000000000022";
const OPERATION_KEYS = [
  "realDeploymentBound", "readyRuntimeVisible", "prerequisitesPassed", "webModeEnabled", "hardwareKeyAbsent",
  "wrongConfirmationDenied", "wrongConfirmationNoMutation", "firstPreparedViaUi", "firstCommitRolledBack",
  "rollbackVisibleAndAutomaticRestored", "staleCommitCleared", "secondPreparedViaUi", "secondCommitEnabled",
  "enabledVisible", "reloadRetained", "auditTransitionsPresent", "auditChainValid", "factorMaterialNotRendered",
  "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied",
  "memberDirectRouteDenied",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Encryption transition browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Encryption transition browser ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Encryption transition origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Encryption transition browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]),
    output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Encryption transition artifact escapes the repository");
  }
  return result;
}

async function openEncryption(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/encryption", origin).href });
  return cdp.wait(`(() => ({ready:Boolean(document.querySelector(".encryption-panel .encryption-summary")&&!document.querySelector(".encryption-state--error")),error:document.querySelector(".encryption-state--error")?.textContent||null}))()`, "Encryption administration", 60_000);
}

async function status(cdp) {
  return cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`);
}

async function prepareWithUi(cdp) {
  need(await cdp.evaluate(setter('.encryption-enable input[name="recoveryVerificationId"]', RECOVERY_TICKET)), "recovery verification input is missing");
  need(await cdp.evaluate(setter('.encryption-enable input[name="selectedVerificationId"]', WEB_TICKET)), "Web verification input is missing");
  need(await cdp.evaluate(setter('.encryption-enable > label input', "PREPARE WEB PASSPHRASE")), "prepare confirmation input is missing");
  await cdp.wait(`({ready:document.querySelector(".encryption-enable .primary-button")?.disabled===false})`, "enabled prepare action", 10_000);
  need(await cdp.evaluate(`document.querySelector(".encryption-enable").requestSubmit(),true`), "prepare form is missing");
  await cdp.wait(`({ready:Boolean(document.querySelector(".encryption-commit")),notice:document.querySelector(".encryption-notice")?.textContent||null})`, "prepared encryption transition", 180_000);
  const observed = await status(cdp); need(observed.status === 200 && observed.value?.latestTransition?.state === "prepared", "prepared transition is not visible through the API");
  return observed.value.latestTransition;
}

async function commitWithUi(cdp, planId) {
  need(await cdp.evaluate(setter('.encryption-commit input', `ENABLE ${planId}`)), "commit confirmation input is missing");
  await cdp.wait(`({ready:document.querySelector(".encryption-commit .danger-button")?.disabled===false})`, "enabled commit action", 10_000);
  need(await cdp.evaluate(`document.querySelector(".encryption-commit .danger-button").click(),true`), "commit button is missing");
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Encryption transition browser evidence exists; use a new run ID"); })
    .catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.encryption"
    && [images["catalog-web"], images["catalog-platform-api"], images["unlock-transition-controller"]].every((item) => SHA256.test(item ?? "")), "Encryption transition deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Encryption transition origin differs from deployment plan");
  need((plan.healthChecks ?? []).some((item) => item.key === "admin-encryption-ready-and-fenced")
    && (plan.retainedStateChecks ?? []).some((item) => item.key === "admin-encryption-post-restart"), "Encryption transition deployment lacks readiness or restart proof");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  const transitionFacts = { firstPlanId: null, secondPlanId: null, finalMode: null, finalState: null, recentTransitionCount: 0 };
  let runtime = null, failure = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime; operations.realDeploymentBound = true;
    await signIn(cdp, options.origin, accounts.owner); await openEncryption(cdp, options.origin); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const initial = await status(cdp), initialText = await cdp.evaluate(`document.querySelector(".encryption-panel")?.innerText||""`);
    operations.readyRuntimeVisible = initial.status === 200 && initial.value?.blockEncryption?.status === "verified"
      && initial.value?.startupProtection?.enabled === false && initial.value?.startupProtection?.mode === "automatic" && initial.value?.capabilities?.transition === true;
    operations.prerequisitesPassed = initial.value?.prerequisites?.length === 5 && initial.value.prerequisites.every((item) => item.state === "passed" && SHA256.test(item.evidenceDigest));
    operations.webModeEnabled = initial.value?.capabilities?.webPassphrase === true && /Web/.test(initialText)
      && await cdp.evaluate(`document.querySelectorAll(".encryption-mode")[0]?.disabled===false`);
    operations.hardwareKeyAbsent = !Object.hasOwn(initial.value?.capabilities ?? {}, "usbKey") && await cdp.evaluate(`document.querySelectorAll(".encryption-mode").length===1`);
    need(operations.readyRuntimeVisible && operations.prerequisitesPassed && operations.webModeEnabled && operations.hardwareKeyAbsent, "initial transition readiness is incomplete");
    const invalid = await cdp.evaluate(`(async()=>{const token=decodeURIComponent((document.cookie.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-teamaibox-csrf="))||"=").split("=").slice(1).join("=")),before=await (await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin"})).json(),response=await fetch("/api/v1/admin/encryption/protection/enable",{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json","x-csrf-token":token},body:JSON.stringify({phase:"prepare",mode:"web_passphrase",recovery_verification_id:"${RECOVERY_TICKET}",selected_verification_id:"${WEB_TICKET}",request_id:crypto.randomUUID(),confirmation:"PREPARE"})}),body=await response.json(),after=await (await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin"})).json();return{status:response.status,code:body?.error?.code,beforeCount:before.recentTransitions?.length,afterCount:after.recentTransitions?.length,enabled:after.startupProtection?.enabled}})()`);
    operations.wrongConfirmationDenied = invalid.status === 409 && invalid.code === "encryption_confirmation_required";
    operations.wrongConfirmationNoMutation = invalid.beforeCount === 0 && invalid.afterCount === 0 && invalid.enabled === false;
    need(operations.wrongConfirmationDenied && operations.wrongConfirmationNoMutation, "wrong confirmation did not fail closed");
    const first = await prepareWithUi(cdp); transitionFacts.firstPlanId = first.planId; operations.firstPreparedViaUi = first.state === "prepared" && first.revision === 1;
    await commitWithUi(cdp, first.planId);
    const rolledBack = await cdp.wait(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),value=await response.json();return{ready:value.latestTransition?.state==="rolled_back"&&value.latestTransition?.rollbackPassed===true,value}})()`, "rolled-back first transition", 180_000);
    operations.firstCommitRolledBack = rolledBack.value?.latestTransition?.planId === first.planId && rolledBack.value?.latestTransition?.failureCode === "commit_failed_rolled_back";
    operations.rollbackVisibleAndAutomaticRestored = rolledBack.value?.startupProtection?.enabled === false && rolledBack.value?.startupProtection?.mode === "automatic";
    await cdp.wait(`({ready:Boolean(document.querySelector(".encryption-history")&&!document.querySelector(".encryption-state"))})`, "rolled-back Encryption UI", 60_000);
    operations.staleCommitCleared = await cdp.evaluate(`!document.querySelector(".encryption-commit")&&document.querySelector(".encryption-history")?.innerText.includes(${JSON.stringify(first.planId)})`);
    need(operations.firstCommitRolledBack && operations.rollbackVisibleAndAutomaticRestored && operations.staleCommitCleared, "first transition did not visibly roll back");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-rollback-zh-dark", ".encryption-panel"));
    const second = await prepareWithUi(cdp); transitionFacts.secondPlanId = second.planId; operations.secondPreparedViaUi = second.state === "prepared" && second.planId !== first.planId;
    await commitWithUi(cdp, second.planId);
    const enabled = await cdp.wait(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),value=await response.json();return{ready:value.latestTransition?.state==="enabled"&&value.startupProtection?.enabled===true&&value.startupProtection?.mode==="web_passphrase",value}})()`, "enabled startup protection", 180_000);
    operations.secondCommitEnabled = enabled.value?.latestTransition?.planId === second.planId && enabled.value?.latestTransition?.rollbackPassed === null;
    operations.enabledVisible = await cdp.wait(`({ready:Boolean(!document.querySelector(".encryption-enable")&&!document.querySelector(".encryption-commit")&&document.querySelector(".encryption-history"))})`, "enabled Encryption UI", 60_000).then(() => true);
    transitionFacts.finalMode = enabled.value.startupProtection.mode; transitionFacts.finalState = enabled.value.latestTransition.state; transitionFacts.recentTransitionCount = enabled.value.recentTransitions.length;
    need(operations.secondPreparedViaUi && operations.secondCommitEnabled && operations.enabledVisible, "second transition did not enable startup protection");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-enabled-zh-dark", ".encryption-panel"));
    await cdp.send("Page.reload", { ignoreCache: false }); await openEncryption(cdp, options.origin);
    const retained = await status(cdp); operations.reloadRetained = retained.status === 200 && retained.value?.startupProtection?.enabled === true
      && retained.value?.startupProtection?.mode === "web_passphrase" && retained.value?.latestTransition?.planId === second.planId;
    const audit = await cdp.evaluate(`(async()=>{const [verified,events]=await Promise.all([fetch("/api/v1/admin/audit/verify",{credentials:"same-origin"}),fetch("/api/v1/admin/audit/events?domain=security&limit=100",{credentials:"same-origin"})]),verification=await verified.json(),inventory=await events.json(),actions=(inventory.data||[]).map(item=>item.action);return{verifyStatus:verified.status,valid:verification.valid,eventStatus:events.status,actions}})()`);
    operations.auditChainValid = audit.verifyStatus === 200 && audit.valid === true;
    operations.auditTransitionsPresent = audit.eventStatus === 200 && ["security.unlock_protection_prepared", "security.unlock_protection_rolled_back", "security.unlock_protection_enabled"].every((action) => audit.actions.includes(action))
      && audit.actions.filter((action) => action === "security.unlock_protection_prepared").length >= 2;
    const panelText = await cdp.evaluate(`document.querySelector(".encryption-panel")?.innerText||""`);
    operations.factorMaterialNotRendered = !panelText.includes(RECOVERY_TICKET) && !panelText.includes(WEB_TICKET);
    need(operations.reloadRetained && operations.auditChainValid && operations.auditTransitionsPresent && operations.factorMaterialNotRendered, "retained state, audit, or factor privacy failed");
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    need(await cdp.evaluate(`(() => {const p=document.querySelector(".encryption-panel")?.innerText||"";return /LUKS2 verified/.test(p)&&/Enabled/.test(p)&&/Web passphrase/.test(p)})()`), "English enabled state is incomplete");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-enabled-en-light", ".encryption-panel"));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openEncryption(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,summary:document.querySelectorAll(".encryption-summary article").length,history:document.querySelectorAll(".encryption-history article").length})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.summary === 3 && mobile.history >= 2;
    need(operations.mobileNoOverflow, "mobile enabled Encryption layout overflowed or lost history");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-enabled-mobile-en-light", ".encryption-panel"));
    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/encryption", options.origin).href });
    await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member direct Encryption denial");
    const member = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".encryption-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page),status:response.status}})()`);
    operations.memberAdminHidden = member.adminNav === false; operations.memberApiDenied = member.status === 403;
    operations.memberDirectRouteDenied = member.panel === false && member.denial && !member.ownerClaim && member.memberClaim;
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Encryption transition browser operations did not pass");
    need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-encryption-transition-browser.v1", runId: options.runId,
    featureKey: "admin.encryption", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(),
    browser: runtime?.browser ?? null, operations, transitionFacts, screenshots, console: { errorCount: runtime?.errors.length ?? 0 },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId,
      webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], controllerImageId: images["unlock-transition-controller"] },
    privacy: { credentialsRetained: false, factorMaterialRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true },
    limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed",
      activeMediaMigration: "not_performed_disposable_regular_file_luks2_only", hardwareKey: "retired_not_required" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Encryption transition browser failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length,
    screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Encryption transition browser failed"}\n`); process.exitCode = 1; });
