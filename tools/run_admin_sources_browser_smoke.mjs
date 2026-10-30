#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  CHROME, canonical, credentialsFromStdin, digest, need, setPreferences,
  shotElement, signIn, startChrome, stopChrome,
} from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-sources-browser-[0-9]{8}-a[1-9][0-9]*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_KEY = "pip.acceptance.cache";
const OPERATION_KEYS = [
  "ownerWorkspaceVisible", "dataPlanesVisible", "realCountersVisible", "durableConfigurationVisible",
  "allEcosystemsVisible", "offlineMediaVisible", "verifiedMediumVisible", "failureMediaVisible",
  "sourceDisabledThroughUi", "sourceDisableReloadRetained", "sourceRestoredThroughUi",
  "corruptApprovalDenied", "wrongArchitectureDenied", "auditActionsVisible", "auditChainValid",
  "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden",
  "memberApiDenied", "memberDirectRouteDenied", "consoleClean",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Sources browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "deployment-evidence", "output", "screenshots"]) need(values[key], `Admin Sources browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "Admin Sources browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Sources browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Sources browser artifact escapes the repository");
  }
  return result;
}

async function openSources(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/sources", origin).href });
  return cdp.wait(`({ready:Boolean(document.querySelector(".source-center")&&document.querySelector(".source-data-planes")&&!document.querySelector(".source-center-state")),error:document.querySelector(".source-center-error")?.textContent||null})`, "Source Center", 60_000);
}

const sourceApi = `(async()=>{const response=await fetch("/api/v1/admin/source-center/sources",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const policyApi = `(async()=>{const response=await fetch("/api/v1/admin/source-center/policies",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const mediaApi = `(async()=>{const response=await fetch("/api/v1/admin/source-center/offline-media",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const planeApi = `(async()=>{const response=await fetch("/api/v1/admin/source-center/data-planes",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,value:await response.json()}})()`;
const csrfExpression = `decodeURIComponent(document.cookie.split(";").map(part=>part.trim()).find(part=>part.startsWith("__Host-teamaibox-csrf="))?.split("=").slice(1).join("=")||"")`;

async function toggleSource(cdp, expectedEnabled) {
  need(await cdp.evaluate(`(() => {const card=[...document.querySelectorAll(".source-card")].find(item=>item.querySelector("code")?.textContent===${JSON.stringify(SOURCE_KEY)});const button=card?.querySelector("footer button");if(!button||button.disabled)return false;button.click();return true})()`), `Source ${SOURCE_KEY} toggle is unavailable`);
  await cdp.wait(`(async()=>{const result=await (${sourceApi});const item=result.value?.data?.find(value=>value.sourceKey===${JSON.stringify(SOURCE_KEY)});const card=[...document.querySelectorAll(".source-card")].find(value=>value.querySelector("code")?.textContent===${JSON.stringify(SOURCE_KEY)});return{ready:result.status===200&&item?.enabled===${expectedEnabled}&&Boolean(card?.classList.contains("is-disabled"))===${!expectedEnabled},error:document.querySelector(".source-center-error")?.textContent||null}})()`, `Source ${SOURCE_KEY} enabled=${expectedEnabled}`, 60_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Sources browser evidence exists; use a new run ID"); }).catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)$/);
  need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.sources" && [images["catalog-web"], images["catalog-platform-api"], images["catalog-postgres"], images["agent-sandbox"]].every((item) => SHA256.test(item ?? "")), "Admin Sources deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "Admin Sources origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });

  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null, dataPlanes = null, configuration = null, offlineMedia = null;
  try {
    runtime = await startChrome(options.chrome);
    const { cdp, errors } = runtime;
    await signIn(cdp, options.origin, accounts.owner); await openSources(cdp, options.origin);
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const sources = await cdp.evaluate(sourceApi), policies = await cdp.evaluate(policyApi), media = await cdp.evaluate(mediaApi), planes = await cdp.evaluate(planeApi);
    need([sources, policies, media, planes].every((item) => item.status === 200), "Source Center browser APIs are incomplete");
    const acceptanceSources = sources.value.data.filter((item) => item.sourceKey.includes(".acceptance."));
    const acceptancePolicies = policies.value.data.filter((item) => item.policyKey.includes(".acceptance."));
    const verified = media.value.data.find((item) => item.volumeLabel.includes("VERIFIED"));
    const corrupt = media.value.data.find((item) => item.volumeLabel.includes("CORRUPT"));
    const wrongArch = media.value.data.find((item) => item.volumeLabel.includes("WRONG ARCH"));
    operations.ownerWorkspaceVisible = await cdp.evaluate(`Boolean(document.querySelector(".source-center")&&document.querySelector(".source-center-summary")&&document.querySelector(".source-center-grid")&&!document.querySelector(".source-center-error"))`);
    operations.dataPlanesVisible = planes.value.state === "ready" && await cdp.evaluate(`document.querySelector(".source-data-planes")?.classList.contains("source-data-planes--ready")&&document.querySelectorAll(".source-data-planes article").length===3`);
    operations.realCountersVisible = ["pip", "npm", "apt"].every((key) => planes.value.ecosystems[key].requests > 0 && planes.value.ecosystems[key].cacheHits > 0
      && planes.value.ecosystems[key].upstreamFetches >= 0 && planes.value.ecosystems[key].upstreamBytes >= 0)
      && await cdp.evaluate(`![...document.querySelectorAll(".source-data-planes dd")].some(item=>item.textContent==="—")`);
    operations.durableConfigurationVisible = acceptanceSources.length === 4 && acceptancePolicies.length === 3;
    operations.allEcosystemsVisible = new Set(acceptanceSources.map((item) => item.ecosystem)).size === 3 && await cdp.evaluate(`document.querySelectorAll(".source-center-summary>button").length===3`);
    operations.offlineMediaVisible = media.value.data.length === 3 && await cdp.evaluate(`document.querySelectorAll(".offline-media-card").length===3`);
    operations.verifiedMediumVisible = verified?.availability === "attached" && verified.approvalState === "approved" && verified.lifecycleState === "ready" && verified.health.state === "healthy" && verified.inventory?.complete === true;
    operations.failureMediaVisible = [corrupt, wrongArch].every((item) => item?.availability === "attached" && item.approvalState === "pending" && item.lifecycleState === "discovered");
    need(["ownerWorkspaceVisible", "dataPlanesVisible", "realCountersVisible", "durableConfigurationVisible", "allEcosystemsVisible", "offlineMediaVisible", "verifiedMediumVisible", "failureMediaVisible"].every((key) => operations[key]), "Source Center owner view is incomplete or not truthful");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-pip-zh-dark", ".source-center"));

    const denial = async (item, code) => cdp.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(`/api/v1/admin/source-center/offline-media/${item.mediaId}/approve`)},{method:"POST",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json","x-csrf-token":${csrfExpression}},body:JSON.stringify({expectedRevision:${item.revision},expectedManifestSha256:${JSON.stringify(item.observedManifestSha256)}})});return{status:response.status,value:await response.json()}})()`);
    const corruptDenied = await denial(corrupt), wrongDenied = await denial(wrongArch);
    operations.corruptApprovalDenied = corruptDenied.status === 409 && corruptDenied.value.error?.code === "offline_media_artifact_invalid";
    operations.wrongArchitectureDenied = wrongDenied.status === 409 && wrongDenied.value.error?.code === "offline_media_architecture_unsupported";

    await toggleSource(cdp, false); operations.sourceDisabledThroughUi = true;
    await cdp.send("Page.reload", { ignoreCache: false }); await openSources(cdp, options.origin);
    const disabled = await cdp.evaluate(sourceApi);
    operations.sourceDisableReloadRetained = disabled.value.data.find((item) => item.sourceKey === SOURCE_KEY)?.enabled === false
      && await cdp.evaluate(`Boolean([...document.querySelectorAll(".source-card")].find(item=>item.querySelector("code")?.textContent===${JSON.stringify(SOURCE_KEY)})?.classList.contains("is-disabled"))`);
    await toggleSource(cdp, true); operations.sourceRestoredThroughUi = true;

    const audit = await cdp.evaluate(`(async()=>{const events=await (await fetch("/api/v1/admin/audit/events?domain=source&limit=200",{credentials:"same-origin",headers:{accept:"application/json"}})).json(),response=await fetch("/api/v1/admin/audit/verify",{credentials:"same-origin",headers:{accept:"application/json"}}),verified=await response.json();return{actions:events.data?.map(item=>item.action)||[],verified:response.status===200&&verified.valid===true}})()`);
    operations.auditActionsVisible = ["source_center.source_created", "source_center.health_recorded", "source_center.policy_created", "source_center.offline_media_discovered", "source_center.offline_media_approved"].every((action) => audit.actions.includes(action)) && audit.actions.filter((action) => action === "source_center.source_updated").length >= 2;
    operations.auditChainValid = audit.verified;
    need(operations.corruptApprovalDenied && operations.wrongArchitectureDenied && operations.sourceDisableReloadRetained && operations.auditActionsVisible && operations.auditChainValid,
      `Source Center mutation, denial, or audit proof is incomplete: corrupt=${corruptDenied.status}/${corruptDenied.value?.error?.code ?? "none"}, architecture=${wrongDenied.status}/${wrongDenied.value?.error?.code ?? "none"}`);
    dataPlanes = { state: planes.value.state, ecosystems: Object.fromEntries(Object.entries(planes.value.ecosystems).map(([key, value]) => [key, { requests: value.requests, cacheHits: value.cacheHits, upstreamFetches: value.upstreamFetches, upstreamBytes: value.upstreamBytes }])) };
    configuration = { sourceCount: acceptanceSources.length, policyCount: acceptancePolicies.length, ecosystems: [...new Set(acceptanceSources.map((item) => item.ecosystem))].sort(), protectedCredentialReferences: acceptanceSources.filter((item) => item.credentialConfigured).length, restoredSourceKey: SOURCE_KEY, restoredEnabled: true };
    offlineMedia = { count: media.value.data.length, verifiedMediaId: verified.mediaId, verifiedState: "approved-ready-healthy", pendingFailureMedia: 2, corruptDeniedStatus: corruptDenied.status, wrongArchitectureDeniedStatus: wrongDenied.status };

    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    need(await cdp.evaluate(`(() => {const button=[...document.querySelectorAll(".source-center-summary>button")].find(item=>item.querySelector("span")?.textContent==="NPM");if(!button)return false;button.click();return true})()`), "NPM Source Center tab is unavailable");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-npm-en-light", ".source-center"));

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openSources(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,workspace:Boolean(document.querySelector(".source-center")),dataPlanes:document.querySelectorAll(".source-data-planes article").length,media:document.querySelectorAll(".offline-media-card").length,error:Boolean(document.querySelector(".source-center-error"))})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.workspace && mobile.dataPlanes === 3 && mobile.media === 3 && !mobile.error;
    need(operations.mobileNoOverflow, "Admin Sources mobile layout overflowed or lost facts");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".source-center"));

    await signIn(cdp, options.origin, accounts.member); await setPreferences(cdp, { locale: "en", theme: "light" });
    await cdp.send("Page.navigate", { url: new URL("/admin/sources", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member Source Center direct-route denial");
    const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/source-center/overview",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".source-center")),denial:Boolean(document.querySelector(".admin-access-denied")),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}})()`);
    operations.memberAdminHidden = denied.adminNav === false; operations.memberApiDenied = denied.status === 403;
    operations.memberDirectRouteDenied = denied.panel === false && denied.denial === true && denied.locale === "en" && denied.theme === "light" && denied.width === 390 && denied.scrollWidth <= 390;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "member-denied-mobile-en-light", ".admin-access-denied"));
    operations.consoleClean = errors.length === 0;
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Sources browser operations did not pass");
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 1, runnerId: "teamaibox.admin-sources-browser-smoke.v1", runId: options.runId, featureKey: "admin.sources", status: failure ? "failed" : "passed", origin: options.origin,
    startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations, dataPlanes, configuration, offlineMedia, screenshots,
    console: { errorCount: runtime?.errors.length ?? 0 }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) },
    deployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"], postgresImageId: images["catalog-postgres"], sandboxImageId: images["agent-sandbox"] },
    privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true },
    limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", physicalOfflineMedia: "containerized_signed_media_fixture_only" }, failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Sources browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Sources browser smoke failed"}\n`); process.exitCode = 1; });
