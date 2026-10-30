#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { CHROME, canonical, credentialsFromStdin, digest, need, setPreferences, shotElement, signIn, startChrome, stopChrome } from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^admin-encryption-post-restart-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const OPERATIONS = ["exactParentsBound", "ownerEnabledStatus", "rollbackAndEnabledHistory", "noStaleMutationControls", "factorMaterialNotRendered", "auditChainValid", "chineseDarkApplied", "englishLightApplied", "mobileNoOverflow", "memberAdminHidden", "memberApiDenied", "memberDirectRouteDenied"];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "post-restart browser arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["origin", "run-id", "deployment-evidence", "transition-browser-evidence", "restart-evidence", "output", "screenshots"]) need(values[key], `post-restart browser ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/", "post-restart browser origin must be exact HTTPS"); need(RUN_ID.test(values["run-id"]), "post-restart browser run ID is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deployment: resolve(values["deployment-evidence"]), transition: resolve(values["transition-browser-evidence"]), restart: resolve(values["restart-evidence"]), output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deployment, result.transition, result.restart, result.output, result.screenshots]) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "post-restart browser artifact escapes repository"); }
  return result;
}

async function openEncryption(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/encryption", origin).href });
  return cdp.wait(`({ready:Boolean(document.querySelector(".encryption-panel .encryption-summary")&&!document.querySelector(".encryption-state--error"))})`, "post-restart Encryption page", 60_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)), accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("post-restart browser evidence exists; use a new run ID"); }).catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deployment), transitionBytes = await readFile(options.transition), restartBytes = await readFile(options.restart);
  const deployment = JSON.parse(deploymentBytes), transition = JSON.parse(transitionBytes), restart = JSON.parse(restartBytes);
  need(deployment.status === "passed" && deployment.featureKey === "admin.encryption" && transition.status === "passed" && transition.deployment?.runId === deployment.runId
    && transition.transitionFacts?.finalState === "enabled" && restart.status === "passed" && restart.deployment?.runId === deployment.runId && restart.browser?.runId === transition.runId, "post-restart browser parents are not exact");
  const plan = JSON.parse(await readFile(resolve(ROOT, `deploy/application-catalog-e2e/plan-${deployment.runId.match(/-(20[0-9]{6})-([a-z0-9-]+)$/)[1]}-${deployment.runId.match(/-(20[0-9]{6})-([a-z0-9-]+)$/)[2]}.json`)));
  need(options.origin.replace(/\/$/, "") === plan.environment.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN, "post-restart browser origin differs from deployment");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATIONS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime; operations.exactParentsBound = true;
    await signIn(cdp, options.origin, accounts.owner); await openEncryption(cdp, options.origin); await setPreferences(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true;
    const owner = await cdp.evaluate(`(async()=>{const [statusResponse,auditResponse]=await Promise.all([fetch("/api/v1/admin/encryption/status",{credentials:"same-origin"}),fetch("/api/v1/admin/audit/verify",{credentials:"same-origin"})]),status=await statusResponse.json(),audit=await auditResponse.json(),panel=document.querySelector(".encryption-panel")?.innerText||"";return{statusCode:statusResponse.status,status,auditCode:auditResponse.status,audit,panel,enable:Boolean(document.querySelector(".encryption-enable")),commit:Boolean(document.querySelector(".encryption-commit")),history:[...document.querySelectorAll(".encryption-history article")].map(item=>item.innerText)}})()`);
    operations.ownerEnabledStatus = owner.statusCode === 200 && owner.status?.blockEncryption?.status === "verified" && owner.status?.startupProtection?.enabled === true && owner.status?.startupProtection?.mode === "web_passphrase" && owner.status?.latestTransition?.state === "enabled";
    operations.rollbackAndEnabledHistory = owner.status?.recentTransitions?.some((item) => item.state === "rolled_back") && owner.status?.recentTransitions?.some((item) => item.state === "enabled") && owner.history.length >= 2;
    operations.noStaleMutationControls = owner.enable === false && owner.commit === false;
    operations.factorMaterialNotRendered = !owner.panel.includes("018f0000-0000-7000-8000-000000000021") && !owner.panel.includes("018f0000-0000-7000-8000-000000000022");
    operations.auditChainValid = owner.auditCode === 200 && owner.audit?.valid === true;
    need(operations.ownerEnabledStatus && operations.rollbackAndEnabledHistory && operations.noStaleMutationControls && operations.factorMaterialNotRendered && operations.auditChainValid, "post-restart owner Encryption state is incomplete");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-post-restart-zh-dark", ".encryption-panel"));
    await setPreferences(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await openEncryption(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,history:document.querySelectorAll(".encryption-history article").length,enabled:/Enabled/.test(document.querySelector(".encryption-panel")?.innerText||"")})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light" && mobile.history >= 2 && mobile.enabled;
    need(operations.mobileNoOverflow, "post-restart mobile Encryption state overflowed or changed");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-post-restart-mobile-en-light", ".encryption-panel"));
    await signIn(cdp, options.origin, accounts.member); await cdp.send("Page.navigate", { url: new URL("/admin/encryption", options.origin).href }); await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "post-restart member denial");
    const member = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin"}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".encryption-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page)}})()`);
    operations.memberAdminHidden = !member.adminNav; operations.memberApiDenied = member.status === 403; operations.memberDirectRouteDenied = !member.panel && member.denial && !member.ownerClaim && member.memberClaim;
    need(OPERATIONS.every((key) => operations[key] === true), "one or more post-restart browser operations failed"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { if (runtime) await stopChrome(runtime); accounts.owner.password = accounts.member.password = "[REDACTED]"; }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.admin-encryption-post-restart-browser.v1", runId: options.runId, featureKey: "admin.encryption", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations, screenshots, console: { errorCount: runtime?.errors.length ?? 0 },
    source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) },
    parents: { deployment: { path: relative(ROOT, options.deployment), digest: digest(deploymentBytes), runId: deployment.runId }, transitionBrowser: { path: relative(ROOT, options.transition), digest: digest(transitionBytes), runId: transition.runId }, restart: { path: relative(ROOT, options.restart), digest: digest(restartBytes), runId: restart.runId } },
    privacy: { credentialsRetained: false, factorMaterialRetained: false, commandOutputRetained: false }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", activeMediaMigration: "not_performed_disposable_regular_file_luks2_only", usbSdkAndDevice: "not_available_not_claimed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`post-restart Encryption browser failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATIONS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "post-restart Encryption browser failed"}\n`); process.exitCode = 1; });
