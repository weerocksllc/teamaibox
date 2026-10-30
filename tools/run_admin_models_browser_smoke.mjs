#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  CHROME, canonical, credentialsFromStdin, digest, need, setPreferences,
  shotElement, signIn, startChrome, stopChrome,
} from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-models-browser-[0-9]{8}-a[1-9][0-9]*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PROFILE_ID = process.env.TEAMAIBOX_BROWSER_MODEL_PROFILE_ID;
const PROFILE_KEY = "asr.whisper-large-v3.fp16.spark-worker02.audio.v2";
const CERTIFIED_KEY = process.env.TEAMAIBOX_CERTIFIED_PROFILE_KEY;
const POLICY_KEY = "validation.default";
const OPERATION_KEYS = [
  "ownerWorkspaceVisible", "durableProfilesVisible", "evidenceCardVisible", "productionBlockedVisible",
  "runtimeTruthVisible", "validationRouteInitiallyDisabled", "validationRouteEnabledThroughUi",
  "validationRouteReloadRetained", "validationRouteRestoredThroughUi", "productionApiDenied",
  "certifiedProfileUiIneligible", "auditActionsVisible", "auditChainValid", "chineseDarkApplied",
  "englishLightApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied",
  "memberDirectRouteDenied", "consoleClean",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Models browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Models browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Models browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Models browser run ID is invalid");
  const result = {
    origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]),
    output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME,
  };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Models browser artifact escapes the repository");
  }
  return result;
}

async function openModels(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/models", origin).href });
  return cdp.wait(`({ready:Boolean(document.querySelector(".model-admin-workspace")&&document.querySelector(".model-card-header")&&document.querySelector(".model-runtime-section")?.dataset.modelRuntimeState!=="loading"),error:document.querySelector(".model-admin-state--error")?.textContent||null})`, "Models administration", 60_000);
}

async function selectProfile(cdp, profileKey) {
  need(await cdp.evaluate(`(() => {const button=[...document.querySelectorAll(".model-profile-list>button")].find(item=>item.querySelector("strong")?.textContent===${JSON.stringify(profileKey)});if(!button)return false;button.click();return true})()`), `model profile is missing: ${profileKey}`);
  await cdp.wait(`({ready:document.querySelector(".model-card-header h2")?.textContent===${JSON.stringify(profileKey)}&&document.querySelector(".model-runtime-section")?.dataset.modelRuntimeState!=="loading",error:document.querySelector(".model-admin-state--error")?.textContent||null})`, `model card ${profileKey}`, 60_000);
}

const profilesApi = `(async()=>{const response=await fetch("/api/v1/admin/model-profiles?limit=200",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const cardApi = `(async()=>{const response=await fetch(${JSON.stringify(`/api/v1/admin/model-profiles/by-key/${encodeURIComponent(PROFILE_KEY)}/card`)},{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const policyApi = `(async()=>{const response=await fetch(${JSON.stringify(`/api/v1/admin/model-routing-policies/${POLICY_KEY}/experimental-profiles?environment=validation`)},{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const runtimeApi = `(async()=>{const response=await fetch("/api/v1/admin/operations/dashboard",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const csrfExpression = `decodeURIComponent(document.cookie.split(";").map(part=>part.trim()).find(part=>part.startsWith("__Host-teamaibox-csrf="))?.split("=").slice(1).join("=")||"")`;

async function main() {
  need(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(PROFILE_ID ?? ""), "explicit_TEAMAIBOX_BROWSER_MODEL_PROFILE_ID_required");
  const options = optionsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Models browser evidence exists; use a new run ID"); }).catch((error) => {
    if (error.message?.includes("exists; use")) throw error;
    if (error.code !== "ENOENT") throw error;
  });
  const deploymentBytes = await readFile(options.deploymentEvidence);
  const deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)$/);
  need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.models"
    && [images["catalog-web"], images["catalog-platform-api"], images["catalog-postgres"]].every((item) => SHA256.test(item ?? "")), "Admin Models deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Models origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });

  const startedAt = new Date().toISOString();
  const operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false]));
  const screenshots = [];
  let runtime = null, failure = null, modelFacts = null, runtimeFacts = null, routingFacts = null;
  try {
    runtime = await startChrome(options.chrome);
    const { cdp, errors } = runtime;
    await signIn(cdp, options.origin, accounts.owner);
    await openModels(cdp, options.origin);
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" });
    operations.chineseDarkApplied = true;
    await selectProfile(cdp, PROFILE_KEY);

    const profiles = await cdp.evaluate(profilesApi), card = await cdp.evaluate(cardApi), dashboard = await cdp.evaluate(runtimeApi), initialPolicy = await cdp.evaluate(policyApi);
    need(profiles.status === 200 && card.status === 200 && dashboard.status === 200 && initialPolicy.status === 200, "Models browser APIs are incomplete");
    const profile = profiles.value.data.find((item) => item.profileId === PROFILE_ID);
    need(profile?.state === "experimental" && card.value.profile.profileId === PROFILE_ID, "live ASR model identity drifted");
    operations.ownerWorkspaceVisible = await cdp.evaluate(`Boolean(document.querySelector(".model-admin-workspace")&&document.querySelector(".model-profile-list")&&document.querySelector(".model-card-panel"))`);
    operations.durableProfilesVisible = profiles.value.data.length >= 9 && await cdp.evaluate(`document.querySelectorAll(".model-profile-list>button").length===${profiles.value.data.length}`);
    operations.evidenceCardVisible = card.value.knownLimitations.length > 0 && card.value.rawRunLinks.length > 0 && await cdp.evaluate(`document.querySelectorAll(".model-card-grid--bottom li").length>0&&document.querySelectorAll(".model-evidence-list button").length>0`);
    operations.productionBlockedVisible = card.value.routingRecommendation.productionEligible === false && await cdp.evaluate(`document.querySelector(".model-card-metrics article:nth-child(3) strong")?.textContent===${JSON.stringify("禁止")}`);

    const placements = (dashboard.value.cluster?.aggregate?.models ?? []).filter((item) => item.profileId === PROFILE_ID);
    const workers = (dashboard.value.cluster?.aggregate?.workers ?? []).filter((item) => item.profileId === PROFILE_ID);
    const runtimeView = await cdp.evaluate(`({state:document.querySelector(".model-runtime-section")?.dataset.modelRuntimeState,empty:Boolean(document.querySelector("[data-model-runtime-empty=true]")),models:document.querySelectorAll(".model-runtime-list article").length})`);
    operations.runtimeTruthVisible = runtimeView.state === dashboard.value.cluster.collectionStatus
      && (placements.length + workers.length === 0 ? runtimeView.empty === true : runtimeView.models > 0);
    operations.validationRouteInitiallyDisabled = !initialPolicy.value.experimentalProfileIds.includes(PROFILE_ID)
      && await cdp.evaluate(`document.querySelector(".model-routing-control")?.dataset.modelValidationRoute==="disabled"&&Boolean(document.querySelector(".model-routing-action button"))`);
    need(["ownerWorkspaceVisible", "durableProfilesVisible", "evidenceCardVisible", "productionBlockedVisible", "runtimeTruthVisible", "validationRouteInitiallyDisabled"].every((key) => operations[key]), "Models owner view is incomplete or not truthful");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-asr-zh-dark", ".model-admin-workspace"));

    need(await cdp.evaluate(`(() => {const button=document.querySelector(".model-routing-action button");if(!button||button.disabled)return false;button.click();return true})()`), "validation route enable control is unavailable");
    await cdp.wait(`(async()=>{const policy=await (${policyApi});return{ready:document.querySelector(".model-routing-control")?.dataset.modelValidationRoute==="enabled"&&policy.value?.experimentalProfileIds?.includes(${JSON.stringify(PROFILE_ID)})}})()`, "validation routing UI enable", 60_000);
    operations.validationRouteEnabledThroughUi = true;
    await cdp.send("Page.reload", { ignoreCache: false });
    await openModels(cdp, options.origin); await selectProfile(cdp, PROFILE_KEY);
    const retained = await cdp.evaluate(policyApi);
    operations.validationRouteReloadRetained = retained.value.experimentalProfileIds.includes(PROFILE_ID)
      && await cdp.evaluate(`document.querySelector(".model-routing-control")?.dataset.modelValidationRoute==="enabled"`);
    need(operations.validationRouteReloadRetained, "validation routing UI change did not survive reload");

    const productionDenied = await cdp.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(`/api/v1/admin/model-routing-policies/${POLICY_KEY}/experimental-profiles/${PROFILE_ID}`)},{method:"PUT",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json","x-csrf-token":${csrfExpression}},body:JSON.stringify({environment:"production",enabled:true,reasonKey:"model.routing.experimental_validation",expiresAt:new Date(Date.now()+86400000).toISOString()})});return{status:response.status,value:await response.json()}})()`);
    operations.productionApiDenied = productionDenied.status === 400 && productionDenied.value.error?.code === "model_experimental_policy_invalid";
    need(await cdp.evaluate(`(() => {const button=document.querySelector(".model-routing-action button");if(!button||button.disabled)return false;button.click();return true})()`), "validation route disable control is unavailable");
    await cdp.wait(`(async()=>{const policy=await (${policyApi});return{ready:document.querySelector(".model-routing-control")?.dataset.modelValidationRoute==="disabled"&&!policy.value?.experimentalProfileIds?.includes(${JSON.stringify(PROFILE_ID)})}})()`, "validation routing UI restore", 60_000);
    operations.validationRouteRestoredThroughUi = true;
    routingFacts = { policyKey: POLICY_KEY, environment: "validation", initialEnabled: false, enabledThroughUi: true, reloadRetained: true, finalEnabled: false, productionDeniedStatus: productionDenied.status };

    await selectProfile(cdp, CERTIFIED_KEY);
    operations.certifiedProfileUiIneligible = await cdp.evaluate(`document.querySelector(".model-routing-control")?.dataset.modelValidationRoute==="ineligible"&&!document.querySelector(".model-routing-action button")`);
    need(operations.certifiedProfileUiIneligible, "certified profile exposed an experimental routing control");
    await selectProfile(cdp, PROFILE_KEY);
    const audit = await cdp.evaluate(`(async()=>{const events=await (await fetch("/api/v1/admin/audit/events?domain=model&limit=200",{credentials:"same-origin",headers:{accept:"application/json"}})).json(),verification=await fetch("/api/v1/admin/audit/verify",{credentials:"same-origin",headers:{accept:"application/json"}}),verified=await verification.json();return{actions:events.data?.map(item=>({action:item.action,resourceId:item.resource?.id}))||[],verified:verification.status===200&&verified.valid===true}})()`);
    operations.auditActionsVisible = audit.actions.filter((item) => item.action === "model_profile.experimental_routing_changed" && item.resourceId === PROFILE_ID).length >= 4;
    operations.auditChainValid = audit.verified;
    need(operations.productionApiDenied && operations.auditActionsVisible && operations.auditChainValid, "Models failure or audit evidence is incomplete");

    modelFacts = { profileId: PROFILE_ID, profileKey: PROFILE_KEY, profileCount: profiles.value.data.length, lifecycleState: profile.state, precision: card.value.profile.precision, productionEligible: false, limitationCount: card.value.knownLimitations.length, rawEvidenceCount: card.value.rawRunLinks.length };
    runtimeFacts = { collectionStatus: dashboard.value.cluster.collectionStatus, nodeCount: dashboard.value.cluster.nodeCount, freshNodeCount: dashboard.value.cluster.freshNodeCount, placementCount: placements.length, workerCount: workers.length, renderedEmptyState: runtimeView.empty };
    await setPreferences(cdp, { locale: "en", theme: "light" });
    operations.englishLightApplied = true;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-asr-en-light", ".model-admin-workspace"));

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openModels(cdp, options.origin); await selectProfile(cdp, PROFILE_KEY);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,workspace:Boolean(document.querySelector(".model-admin-workspace")),route:document.querySelector(".model-routing-control")?.dataset.modelValidationRoute,runtime:document.querySelector(".model-runtime-section")?.dataset.modelRuntimeState})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.workspace && mobile.route === "disabled" && mobile.runtime === dashboard.value.cluster.collectionStatus;
    need(operations.mobileNoOverflow, "Admin Models mobile layout overflowed or lost durable facts");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".model-admin-workspace"));

    await signIn(cdp, options.origin, accounts.member);
    await setPreferences(cdp, { locale: "en", theme: "light" });
    await cdp.send("Page.navigate", { url: new URL("/admin/models", options.origin).href });
    await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member Models direct-route denial");
    const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/model-profiles?limit=1",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".model-admin-workspace")),denial:Boolean(document.querySelector(".admin-access-denied")),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}})()`);
    operations.memberAdminHidden = denied.adminNav === false;
    operations.memberApiDenied = denied.status === 403;
    operations.memberDirectRouteDenied = denied.panel === false && denied.denial === true && denied.locale === "en" && denied.theme === "light" && denied.width === 390 && denied.scrollWidth <= 390;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "member-denied-mobile-en-light", ".admin-access-denied"));
    operations.consoleClean = errors.length === 0;
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Models browser operations did not pass");
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    if (runtime) await stopChrome(runtime);
    accounts.owner.password = accounts.member.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 1, runnerId: "teamaibox.admin-models-browser-smoke.v1", runId: options.runId,
    featureKey: "admin.models", status: failure ? "failed" : "passed", origin: options.origin,
    startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations,
    model: modelFacts, runtime: runtimeFacts, routing: routingFacts, screenshots,
    console: { errorCount: runtime?.errors.length ?? 0 },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], postgresImageId: images["catalog-postgres"] },
    privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true },
    limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", physicalModelWorkerLifecycle: "not_claimed_by_model_administration_browser_journey" },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Models browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Models browser smoke failed"}\n`); process.exitCode = 1; });
