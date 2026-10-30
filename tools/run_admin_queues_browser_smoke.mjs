#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  CHROME, canonical, credentialsFromStdin, digest, need, setPreferences, setter,
  shotElement, signIn, startChrome, stopChrome,
} from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-queues-browser-[0-9]{8}-a[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  "ownerWorkspaceVisible", "livePostgresFactsVisible", "sensitiveMetadataRedacted",
  "exactConfirmationRequired", "cancellationThroughUi", "terminalCancellationVisible",
  "policyConflictVisible", "policyUpdatedThroughUi", "policyReloadRetained", "policyRestoredThroughUi",
  "auditActionsVisible", "auditChainValid", "chineseDarkApplied", "englishLightApplied",
  "mobileNoOverflow", "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied", "consoleClean",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "Admin Queues browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "job-id", "deployment-evidence", "output", "screenshots"]) {
    need(values[key], `Admin Queues browser ${key} is required`);
  }
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "Admin Queues browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "Admin Queues browser run ID is invalid");
  need(UUID.test(values["job-id"]), "Admin Queues browser job ID is invalid");
  const result = {
    origin: origin.href, runId: values["run-id"], jobId: values["job-id"],
    deploymentEvidence: resolve(values["deployment-evidence"]), output: resolve(values.output),
    screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME,
  };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) {
    const scoped = relative(ROOT, path);
    need(scoped && scoped !== ".." && !scoped.startsWith("../"), "Admin Queues browser artifact escapes the repository");
  }
  return result;
}

async function openQueues(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/queues", origin).href });
  return cdp.wait(`({ready:Boolean(document.querySelector(".queue-admin .queue-policy")&&!document.querySelector(".queue-admin-state--error")),error:document.querySelector(".queue-admin-state--error")?.textContent||null})`, "Queue administration", 60_000);
}

const queueApi = `(async()=>{const response=await fetch("/api/v1/admin/queues?limit=200",{credentials:"same-origin",headers:{accept:"application/json"}}),value=await response.json();return{ready:response.status===200,status:response.status,value}})()`;
const csrfExpression = `decodeURIComponent(document.cookie.split(";").map(part=>part.trim()).find(part=>part.startsWith("__Host-teamaibox-csrf="))?.split("=").slice(1).join("=")||"")`;

async function setPolicyField(cdp, index, value) {
  need(await cdp.evaluate(`(() => {const element=document.querySelectorAll(".queue-policy-fields input")[${index}];if(!element)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,${JSON.stringify(String(value))});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true})()`),
    `Queue policy field ${index} is missing`);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("Admin Queues browser evidence exists; use a new run ID"); }).catch((error) => {
    if (error.message?.includes("exists; use")) throw error;
    if (error.code !== "ENOENT") throw error;
  });
  const deploymentBytes = await readFile(options.deploymentEvidence);
  const deployment = JSON.parse(deploymentBytes);
  const identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-(a[1-9][0-9]*)$/);
  need(identity, "deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`)));
  const images = Object.fromEntries((deployment.imageBindings ?? []).map((item) => [item.component, item.imageId]));
  need(deployment.status === "passed" && deployment.featureKey === "admin.queues"
    && [images["catalog-web"], images["catalog-platform-api"]].every((item) => SHA256.test(item ?? "")),
  "Admin Queues deployment binding is invalid");
  need(options.origin.replace(/\/$/, "") === plan.environment?.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN,
    "Admin Queues origin differs from deployment plan");
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });

  const startedAt = new Date().toISOString();
  const operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false]));
  const screenshots = [];
  let runtime = null, failure = null, jobFacts = null, policyFacts = null;
  try {
    runtime = await startChrome(options.chrome);
    const { cdp, errors } = runtime;
    await signIn(cdp, options.origin, accounts.owner);
    await openQueues(cdp, options.origin);
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" });
    operations.chineseDarkApplied = true;
    const initial = await cdp.evaluate(queueApi);
    const initialJob = initial.value.jobs.find((item) => item.jobId === options.jobId);
    need(initialJob?.status === "queued" && initialJob.canCancel === true && initialJob.attemptCount === 0,
      "bounded Queue browser job is not a live cancellable PostgreSQL fact");
    operations.ownerWorkspaceVisible = await cdp.evaluate(`Boolean(document.querySelector(".queue-admin")&&document.querySelector(".queue-summary")&&document.querySelector(".queue-jobs"))`);
    operations.livePostgresFactsVisible = await cdp.evaluate(`Boolean(document.querySelector('tr[data-job-id=${JSON.stringify(options.jobId)}] .queue-state--queued'))`);
    const serializedInitial = JSON.stringify(initial.value);
    const pageText = await cdp.evaluate("document.body.innerText");
    operations.sensitiveMetadataRedacted = !serializedInitial.includes("queueBrowserSensitiveMarker")
      && !serializedInitial.includes("must-not-leave-database") && !pageText.includes("must-not-leave-database");
    need(operations.ownerWorkspaceVisible && operations.livePostgresFactsVisible && operations.sensitiveMetadataRedacted,
      "Queue owner view is incomplete or leaked request metadata");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-queued-zh-dark", ".queue-admin"));

    need(await cdp.evaluate(`(() => {const button=document.querySelector('tr[data-job-id=${JSON.stringify(options.jobId)}] .queue-cancel');if(!button)return false;button.click();return true})()`),
      "Queue cancellation control is unavailable");
    await cdp.wait(`({ready:Boolean(document.querySelector(".queue-dialog"))})`, "Queue cancellation dialog");
    const dangerBefore = await cdp.evaluate(`document.querySelector(".queue-dialog .danger-button")?.disabled===true`);
    need(await cdp.evaluate(setter(".queue-dialog input", "CANCEL")), "Queue confirmation input is unavailable");
    const dangerPartial = await cdp.evaluate(`document.querySelector(".queue-dialog .danger-button")?.disabled===true`);
    operations.exactConfirmationRequired = dangerBefore && dangerPartial;
    need(await cdp.evaluate(setter(".queue-dialog input", `CANCEL ${options.jobId}`)), "Queue exact confirmation is unavailable");
    need(await cdp.evaluate(`(() => {const button=document.querySelector(".queue-dialog .danger-button");if(!button||button.disabled)return false;button.click();return true})()`),
      "Queue exact-confirmation cancellation did not become available");
    const cancelled = await cdp.wait(`(async()=>{const result=await (${queueApi}),job=result.value?.jobs?.find(item=>item.jobId===${JSON.stringify(options.jobId)});return{ready:result.status===200&&job?.status==="cancelled"&&job?.cancellationRequested===true&&job?.canCancel===false,job}})()`, "Queue UI cancellation", 60_000);
    jobFacts = cancelled.job;
    operations.cancellationThroughUi = true;
    operations.terminalCancellationVisible = await cdp.evaluate(`Boolean(document.querySelector('tr[data-job-id=${JSON.stringify(options.jobId)}] .queue-state--cancelled')&&document.querySelector('tr[data-job-id=${JSON.stringify(options.jobId)}] .queue-cancel')?.disabled)`);

    const baseline = initial.value.policy;
    await setPolicyField(cdp, 2, baseline.maxQueuedPerOwner + 2);
    const concurrent = await cdp.evaluate(`(async()=>{const csrf=${csrfExpression},policy=${JSON.stringify({
      minimumPriority: 0, maximumPriority: 0, maxQueuedPerOwner: 0, maxActivePerOwner: 0,
      maxQueuedPerCapability: 0, maxDailySubmissionsPerOwner: 0, maxRequestBytes: 0, maxDeadlineSeconds: 0,
    })};Object.assign(policy,${JSON.stringify({})});const current=(await (await fetch("/api/v1/admin/queues?limit=1",{credentials:"same-origin",headers:{accept:"application/json"}})).json()).policy;for(const key of Object.keys(policy))policy[key]=current[key];policy.maxQueuedPerOwner=current.maxQueuedPerOwner+1;const response=await fetch("/api/v1/admin/queues/policy",{method:"PUT",credentials:"same-origin",headers:{accept:"application/json","content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({expectedRevision:current.revision,policy})});return{status:response.status,value:await response.json()}})()`);
    need(concurrent.status === 200 && concurrent.value.revision === baseline.revision + 1
      && concurrent.value.maxQueuedPerOwner === baseline.maxQueuedPerOwner + 1,
    "Queue concurrent policy update did not establish a revision conflict");
    await cdp.evaluate(`document.querySelector(".queue-policy").requestSubmit(),true`);
    const conflict = await cdp.wait(`({ready:Boolean(document.querySelector(".queue-notice"))&&!document.querySelector(".queue-policy button[type=submit]")?.disabled,error:document.querySelector(".queue-notice")?.textContent||null})`, "Queue policy conflict", 30_000);
    const conflictState = await cdp.evaluate(queueApi);
    operations.policyConflictVisible = Boolean(conflict.error) && conflictState.value.policy.revision === baseline.revision + 1
      && conflictState.value.policy.maxQueuedPerOwner === baseline.maxQueuedPerOwner + 1;
    need(operations.policyConflictVisible, "Queue stale revision did not fail visibly and durably");

    await cdp.evaluate(`document.querySelector(".queue-admin__header .secondary-button").click(),true`);
    await cdp.wait(`({ready:document.querySelector(".queue-policy header span")?.textContent===${JSON.stringify(`REV ${baseline.revision + 1}`)}})`, "Queue policy refresh");
    await setPolicyField(cdp, 2, baseline.maxQueuedPerOwner + 2);
    await cdp.evaluate(`document.querySelector(".queue-policy").requestSubmit(),true`);
    const updated = await cdp.wait(`(async()=>{const result=await (${queueApi});return{ready:result.value?.policy?.revision===${baseline.revision + 2}&&result.value?.policy?.maxQueuedPerOwner===${baseline.maxQueuedPerOwner + 2},policy:result.value?.policy}})()`, "Queue policy UI update", 60_000);
    operations.policyUpdatedThroughUi = true;
    await cdp.send("Page.reload", { ignoreCache: false });
    await openQueues(cdp, options.origin);
    const retained = await cdp.evaluate(queueApi);
    operations.policyReloadRetained = retained.value.policy.revision === baseline.revision + 2
      && retained.value.policy.maxQueuedPerOwner === baseline.maxQueuedPerOwner + 2;
    need(operations.policyReloadRetained, "Queue UI policy update did not survive reload");
    await setPolicyField(cdp, 2, baseline.maxQueuedPerOwner);
    await cdp.evaluate(`document.querySelector(".queue-policy").requestSubmit(),true`);
    const restored = await cdp.wait(`(async()=>{const result=await (${queueApi});return{ready:result.value?.policy?.revision===${baseline.revision + 3}&&result.value?.policy?.maxQueuedPerOwner===${baseline.maxQueuedPerOwner},policy:result.value?.policy}})()`, "Queue policy UI restore", 60_000);
    policyFacts = {
      policyKey: baseline.policyKey, initialRevision: baseline.revision,
      conflictRevision: concurrent.value.revision, updatedRevision: updated.policy.revision,
      finalRevision: restored.policy.revision, baselineMaxQueuedPerOwner: baseline.maxQueuedPerOwner,
      testedMaxQueuedPerOwner: updated.policy.maxQueuedPerOwner, finalMaxQueuedPerOwner: restored.policy.maxQueuedPerOwner,
    };
    operations.policyRestoredThroughUi = true;
    const audit = await cdp.evaluate(`(async()=>{const events=await (await fetch("/api/v1/admin/audit/events?domain=administrator&limit=200",{credentials:"same-origin",headers:{accept:"application/json"}})).json(),verification=await fetch("/api/v1/admin/audit/verify",{credentials:"same-origin",headers:{accept:"application/json"}}),verified=await verification.json();return{actions:events.data?.map(item=>({action:item.action,resourceId:item.resource?.id}))||[],verified:verification.status===200&&verified.valid===true}})()`);
    operations.auditActionsVisible = audit.actions.filter((item) => item.action === "queue.policy_updated").length >= 5
      && audit.actions.some((item) => item.action === "queue.job_cancellation_requested" && item.resourceId === options.jobId);
    operations.auditChainValid = audit.verified;
    need(operations.auditActionsVisible && operations.auditChainValid, "Queue administrator audit evidence is incomplete");

    await setPreferences(cdp, { locale: "en", theme: "light" });
    operations.englishLightApplied = true;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-terminal-en-light", ".queue-admin"));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openQueues(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,policy:Boolean(document.querySelector(".queue-policy")),terminal:Boolean(document.querySelector('tr[data-job-id=${JSON.stringify(options.jobId)}] .queue-state--cancelled'))})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en"
      && mobile.theme === "light" && mobile.policy && mobile.terminal;
    need(operations.mobileNoOverflow, "Admin Queues mobile layout overflowed or lost durable facts");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-mobile-en-light", ".queue-admin"));

    await signIn(cdp, options.origin, accounts.member);
    await setPreferences(cdp, { locale: "en", theme: "light" });
    await cdp.send("Page.navigate", { url: new URL("/admin/queues", options.origin).href });
    await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "member Queue direct-route denial");
    const denied = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/queues",{credentials:"same-origin",headers:{accept:"application/json"}});return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".queue-admin")),denial:Boolean(document.querySelector(".admin-access-denied")),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}})()`);
    operations.memberAdminHidden = denied.adminNav === false;
    operations.memberApiDenied = denied.status === 403;
    operations.memberDirectRouteDenied = denied.panel === false && denied.denial === true
      && denied.locale === "en" && denied.theme === "light" && denied.width === 390 && denied.scrollWidth <= 390;
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "member-denied-mobile-en-light", ".admin-access-denied"));
    operations.consoleClean = errors.length === 0;
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more Admin Queues browser operations did not pass");
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    if (runtime) await stopChrome(runtime);
    accounts.owner.password = accounts.member.password = "[REDACTED]";
  }
  const seed = new URL("../deploy/application-catalog-e2e/admin-queues-browser-seed.sh", import.meta.url);
  const evidence = {
    schemaVersion: 1, runnerId: "teamaibox.admin-queues-browser-smoke.v1", runId: options.runId,
    featureKey: "admin.queues", status: failure ? "failed" : "passed", origin: options.origin,
    startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations,
    job: jobFacts ? {
      jobId: jobFacts.jobId, capabilityKey: jobFacts.capabilityKey, operation: jobFacts.operation,
      priority: jobFacts.priority, route: jobFacts.route, attemptCount: jobFacts.attemptCount,
      finalStatus: jobFacts.status, cancellationRequested: jobFacts.cancellationRequested,
    } : null,
    policy: policyFacts, screenshots, console: { errorCount: runtime?.errors.length ?? 0 },
    source: {
      runnerDigest: digest(await readFile(new URL(import.meta.url))),
      commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))),
      seedDigest: digest(await readFile(seed)),
    },
    deployment: {
      evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes),
      runId: deployment.runId, webImageId: images["catalog-web"], platformApiImageId: images["catalog-platform-api"],
      postgresImageId: images["catalog-postgres"],
    },
    privacy: { credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true },
    limitations: {
      trustedHttps: "not_satisfied_by_self_signed_component_origin",
      independentHumanAcceptance: "not_performed",
      hardwareScheduling: "not_claimed_by_queue_administration_browser_journey",
    },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`Admin Queues browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "Admin Queues browser smoke failed"}\n`); process.exitCode = 1; });
