#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  CHROME, canonical, credentialsFromStdin, digest, need, setPreferences,
  setter, shotElement, signIn, startChrome, stopChrome,
} from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-updates-browser-[0-9]{8}-a[1-9][0-9]*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUCCESS_CANDIDATE = "platform.2026-08-21";
const FAILURE_CANDIDATE = "platform.2026-08-22-health-failure";
const OPERATION_KEYS = [
  "ownerWorkspaceVisible", "candidateCatalogVisible", "healthyNodeVisible", "existingDurableHistoryVisible",
  "hostBlockerVisible", "successPreparedThroughUi", "inexactConfirmationDenied", "successExecutedThroughUi",
  "successReloadRetained", "failurePreparedThroughUi", "failureRolledBackThroughUi", "evidenceCardsVisible",
  "auditActionsVisible", "auditChainValid", "chineseDarkApplied", "chineseOperationalFactsLocalized", "englishLightApplied", "mobileNoOverflow",
  "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied", "consoleClean",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Updates browser arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Updates browser ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Updates browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Updates browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Updates browser artifact escapes the repository"); }
  return result;
}

const administrationApi = `(async()=>{const response=await fetch("/api/v1/admin/updates",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;

async function openUpdates(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/updates", origin).href });
  return cdp.wait(`({ready:Boolean(document.querySelector(".maintenance-panel")&&document.querySelector(".maintenance-builder")&&!document.querySelector(".maintenance-empty[role=alert]")),error:document.querySelector(".maintenance-empty[role=alert]")?.textContent||null})`, "Updates administration", 60_000);
}

async function configurePlan(cdp, candidateKey) {
  need(await cdp.evaluate(setter(".maintenance-builder-grid label:first-child select", candidateKey, "HTMLSelectElement")), "maintenance candidate selector is missing");
  need(await cdp.evaluate(setter(".maintenance-builder-grid label:nth-child(2) select", "single_node_downtime", "HTMLSelectElement")), "maintenance strategy selector is missing");
  await cdp.wait(`({ready:Boolean(document.querySelector(".maintenance-decisions .is-warning input"))})`, "downtime acknowledgement");
  need(await cdp.evaluate(`(() => {const input=document.querySelector(".maintenance-decisions .is-warning input");if(!input)return false;if(!input.checked)input.click();return input.checked})()`), "downtime acknowledgement is unavailable");
}

async function prepareThroughUi(cdp, candidateKey, priorPlanIds) {
  await configurePlan(cdp, candidateKey);
  need(await cdp.evaluate(`(() => {const button=document.querySelector(".maintenance-builder>.primary-button");if(!button||button.disabled)return false;button.click();return true})()`), `prepare control is unavailable for ${candidateKey}`);
  const observed = await cdp.wait(`(async()=>{const result=await (${administrationApi});const plan=result.value?.plans?.find(item=>item.candidate.candidateKey===${JSON.stringify(candidateKey)}&&!${JSON.stringify(priorPlanIds)}.includes(item.planId));return{ready:result.status===200&&plan?.state==="ready",plan}})()`, `ready plan ${candidateKey}`, 60_000);
  await cdp.wait(`({ready:Boolean(document.querySelector(".maintenance-detail")&&document.querySelector(".maintenance-execute"))})`, `selected plan ${candidateKey}`, 30_000);
  return observed.plan;
}

async function executeThroughUi(cdp, plan, expectedState) {
  const input = ".maintenance-execute input", button = ".maintenance-execute .danger-button";
  need(await cdp.evaluate(setter(input, "APPLY")), "maintenance confirmation input is missing");
  need(await cdp.evaluate(`document.querySelector(${JSON.stringify(button)})?.disabled===true`), "inexact maintenance confirmation was accepted by the UI");
  need(await cdp.evaluate(setter(input, `APPLY ${plan.planId}`)), "exact maintenance confirmation is unavailable");
  need(await cdp.evaluate(`(() => {const button=document.querySelector(${JSON.stringify(button)});if(!button||button.disabled)return false;button.click();return true})()`), "maintenance execute control did not enable for exact confirmation");
  return cdp.wait(`(async()=>{const result=await (${administrationApi});const plan=result.value?.plans?.find(item=>item.planId===${JSON.stringify(plan.planId)});return{ready:result.status===200&&plan?.state===${JSON.stringify(expectedState)},plan}})()`, `maintenance state ${expectedState}`, 120_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Updates browser evidence exists; use a new run ID"); }).catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)$/); need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))), images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.updates" && [images["catalog-web"], images["catalog-platform-api"], images["catalog-postgres"], images["node-agent"], images["maintenance-controller"]].every((item) => SHA256.test(item ?? "")), "Admin Updates deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Updates origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null, maintenance = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime;
    await signIn(cdp, options.origin, accounts.owner); await openUpdates(cdp, options.origin); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const initial = await cdp.evaluate(administrationApi); need(initial.status === 200, "maintenance administration API is unavailable");
    const initialPlanIds = initial.value.plans.map((item) => item.planId);
    operations.ownerWorkspaceVisible = await cdp.evaluate(`Boolean(document.querySelector(".maintenance-panel")&&document.querySelector(".maintenance-builder")&&document.querySelector(".maintenance-workspace"))`);
    operations.candidateCatalogVisible = [SUCCESS_CANDIDATE, FAILURE_CANDIDATE, "host.2026-08-preflight-only"].every((key) => initial.value.candidates.some((item) => item.candidateKey === key)) && await cdp.evaluate(`document.querySelectorAll(".maintenance-builder-grid label:first-child select option").length===3`);
    operations.healthyNodeVisible = initial.value.nodes.some((item) => item.nodeKey === "spark-local" && item.lifecycleState === "ready" && item.healthState === "healthy") && await cdp.evaluate(`document.querySelectorAll(".maintenance-node-picker input:checked").length===1`);
    operations.existingDurableHistoryVisible = ["completed", "rolled_back", "blocked"].every((state) => initial.value.plans.some((item) => item.state === state));
    const host = initial.value.plans.find((item) => item.kind === "host" && item.state === "blocked"); operations.hostBlockerVisible = host?.blockers.includes("runtime_incompatible") === true;
    need(["ownerWorkspaceVisible", "candidateCatalogVisible", "healthyNodeVisible", "existingDurableHistoryVisible", "hostBlockerVisible"].every((key) => operations[key]), "Updates owner workspace or durable history is incomplete");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-history-zh-dark", ".maintenance-panel"));

    const success = await prepareThroughUi(cdp, SUCCESS_CANDIDATE, initialPlanIds); operations.successPreparedThroughUi = success.backupEvidence.current === true && success.preflight.passed === true && success.compatibility.requiresRevalidationProfileIds.length === 1;
    need(await cdp.evaluate(setter(".maintenance-execute input", "APPLY")), "confirmation input is missing"); operations.inexactConfirmationDenied = await cdp.evaluate(`document.querySelector(".maintenance-execute .danger-button")?.disabled===true`);
    const completed = await executeThroughUi(cdp, success, "completed"); operations.successExecutedThroughUi = completed.plan.completedNodeIds.length === 1 && completed.plan.nodeEvidence.length === 1 && completed.plan.postCheck?.passed === true;
    await cdp.send("Page.reload", { ignoreCache: false }); await openUpdates(cdp, options.origin);
    const retained = await cdp.evaluate(administrationApi); operations.successReloadRetained = retained.value.plans.some((item) => item.planId === success.planId && item.state === "completed");

    const failurePlan = await prepareThroughUi(cdp, FAILURE_CANDIDATE, retained.value.plans.map((item) => item.planId)); operations.failurePreparedThroughUi = true;
    const rolledBack = await executeThroughUi(cdp, failurePlan, "rolled_back"); operations.failureRolledBackThroughUi = rolledBack.plan.failureCode === "update_postcheck_failed" && rolledBack.plan.postCheck?.passed === true;
    await cdp.evaluate(`(() => {const cards=[...document.querySelectorAll(".maintenance-plan-card")];const card=cards.find(item=>item.querySelector(".maintenance-state--rolled_back"));if(!card)return false;card.click();return true})()`);
    operations.evidenceCardsVisible = await cdp.evaluate(`document.querySelectorAll(".maintenance-evidence-grid article.is-passed").length===4&&document.querySelectorAll(".maintenance-node-sequence li").length===1`);
    operations.chineseOperationalFactsLocalized = await cdp.evaluate(`(() => {const text=document.querySelector(".maintenance-panel")?.innerText||"";return ["故障回滚演练","存在受管工作负载，执行前必须排空","就绪 · 健康","拒绝不健康候选，并原子恢复上一槽位。","使用耐久计划中记录的上一版本摘要进行人工恢复。"].every(item=>text.includes(item))&&!["failure rehearsal","managed workloads require drain","ready · healthy"].some(item=>text.includes(item))})()`);
    need(["successPreparedThroughUi", "inexactConfirmationDenied", "successExecutedThroughUi", "successReloadRetained", "failurePreparedThroughUi", "failureRolledBackThroughUi", "evidenceCardsVisible", "chineseOperationalFactsLocalized"].every((key) => operations[key]), "Updates UI execution, localization, or rollback journey is incomplete");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-rollback-zh-dark", ".maintenance-panel"));

    const audit = await cdp.evaluate(`(async()=>{const events=await (await fetch("/api/v1/admin/audit/events?domain=update&limit=200",{credentials:"same-origin",headers:{accept:"application/json"}})).json(),response=await fetch("/api/v1/admin/audit/verify",{credentials:"same-origin",headers:{accept:"application/json"}}),verified=await response.json();return{actions:events.data?.map(item=>item.action)||[],verified:response.status===200&&verified.valid===true}})()`);
    operations.auditActionsVisible = ["platform_update.preflight_completed", "platform_update.started", "platform_update.completed", "platform_update.rolled_back", "host_maintenance.preflight_completed"].every((action) => audit.actions.includes(action)); operations.auditChainValid = audit.verified;
    maintenance = { candidateCount: initial.value.candidates.length, nodeCount: initial.value.nodes.length, initialPlanCount: initial.value.plans.length, browserCompletedPlanId: success.planId, browserRolledBackPlanId: failurePlan.planId, blockedHostPlanId: host.planId, backupCurrent: success.backupEvidence.current, preflightPassed: success.preflight.passed, revalidationProfileCount: success.compatibility.requiresRevalidationProfileIds.length };
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true; screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-rollback-en-light", ".maintenance-panel"));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openUpdates(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,panel:Boolean(document.querySelector(".maintenance-panel")),builder:Boolean(document.querySelector(".maintenance-builder")),history:document.querySelectorAll(".maintenance-plan-card").length})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.panel && mobile.builder && mobile.history >= initial.value.plans.length + 2; need(operations.mobileNoOverflow, "Admin Updates mobile layout overflowed or lost state"); screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".maintenance-panel"));

    await signIn(cdp, options.origin, accounts.member); await setPreferences(cdp, { locale: "en", theme: "light" }); await cdp.send("Page.navigate", { url: new URL("/admin/updates", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member Updates direct-route denial");
    const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/updates",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".maintenance-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}})()`);
    operations.memberAdminHidden = denied.adminNav === false; operations.memberApiDenied = denied.status === 403; operations.memberDirectRouteDenied = denied.panel === false && denied.denial && denied.locale === "en" && denied.theme === "light" && denied.width === 390 && denied.scrollWidth <= 390; screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "member-denied-mobile-en-light", ".admin-access-denied"));
    operations.consoleClean = errors.length === 0; need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Updates browser operations did not pass");
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-updates-browser-smoke.v1", runId: options.runId, featureKey: "admin.updates", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations, maintenance, screenshots, console: { errorCount: runtime?.errors.length ?? 0 }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) }, deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], postgresImageId: images["catalog-postgres"], nodeAgentImageId: images["node-agent"], maintenanceControllerImageId: images["maintenance-controller"] }, privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", dualNodeRollingCutover: "not_performed_single_node_downtime_only" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Updates browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Updates browser smoke failed"}\n`); process.exitCode = 1; });
