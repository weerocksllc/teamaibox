#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  CHROME,
  canonical,
  credentialsFromStdin,
  digest,
  need,
  setPreferences,
  shotElement,
  signIn,
  startChrome,
  stopChrome,
} from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^current-optional-luks-browser-[0-9]{8}-a[1-9][0-9]*$/;
const OPERATIONS = [
  "currentRuntimeBound",
  "ownerRouteAvailable",
  "statusApiAvailable",
  "baseDiskTruthful",
  "optionalWebModeVisible",
  "hardwareKeyAbsent",
  "currentTransitionHistoryClean",
  "auditChainValid",
  "factorMaterialNotRendered",
  "chineseDarkApplied",
  "englishLightApplied",
  "mobileNoOverflow",
  "memberAdminHidden",
  "memberApiDenied",
  "memberDirectRouteDenied",
  "normalSystemTrustOnly",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "optional LUKS browser arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["origin", "run-id", "runtime-evidence", "output", "screenshots", "launch-evidence"])
    need(values[key], `optional LUKS browser ${key} is required`);
  const origin = new URL(values.origin);
  need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password,
    "optional LUKS browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]), "optional LUKS browser run identity is invalid");
  const result = {
    origin: origin.href,
    runId: values["run-id"],
    runtimeEvidence: resolve(values["runtime-evidence"]),
    output: resolve(values.output),
    screenshots: resolve(values.screenshots),
    launchEvidence: resolve(values["launch-evidence"]),
    chrome: values.chrome ?? CHROME,
  };
  for (const path of [result.runtimeEvidence, result.output, result.screenshots, result.launchEvidence]) {
    const scoped = relative(ROOT, path);
    need(scoped && scoped !== ".." && !scoped.startsWith("../"), "optional LUKS browser artifact escapes repository");
  }
  return result;
}

async function openEncryption(cdp, origin) {
  await cdp.send("Page.navigate", { url: new URL("/admin/encryption", origin).href });
  return cdp.wait(`(() => ({ready:Boolean(document.querySelector(".encryption-panel .encryption-summary")&&!document.querySelector(".encryption-state--error")),error:document.querySelector(".encryption-state--error")?.textContent||null}))()`, "current Encryption administration", 60_000);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const accounts = await credentialsFromStdin();
  await readFile(options.output).then(() => { throw new Error("optional LUKS browser evidence exists; use a new run ID"); })
    .catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const runtimeBytes = await readFile(options.runtimeEvidence);
  const runtime = JSON.parse(runtimeBytes);
  need(runtime.status === "passed" && runtime.runId === "current-translation-composition-20260830-a3"
    && runtime.runtime?.platform?.healthy === true, "optional LUKS current runtime parent is invalid");
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString();
  const operations = Object.fromEntries(OPERATIONS.map((key) => [key, false]));
  const screenshots = [];
  const observed = { blockEncryptionStatus: null, startupProtectionEnabled: null, startupProtectionMode: null,
    webPassphraseCapable: null, transitionStates: [] };
  let browserRuntime = null;
  let failure = null;
  try {
    browserRuntime = await startChrome(options.chrome);
    const { cdp, errors } = browserRuntime;
    operations.currentRuntimeBound = true;
    await signIn(cdp, options.origin, accounts.owner);
    await openEncryption(cdp, options.origin);
    operations.ownerRouteAvailable = true;
    await setPreferences(cdp, { locale: "zh-CN", theme: "dark" });
    operations.chineseDarkApplied = true;
    const owner = await cdp.evaluate(`(async()=>{const [statusResponse,auditResponse]=await Promise.all([fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),fetch("/api/v1/admin/audit/verify",{credentials:"same-origin",headers:{accept:"application/json"}})]),status=await statusResponse.json(),audit=await auditResponse.json(),panel=document.querySelector(".encryption-panel")?.innerText||"";return{statusCode:statusResponse.status,status,auditCode:auditResponse.status,audit,panel,hasError:Boolean(document.querySelector(".encryption-state--error"))}})()`);
    observed.blockEncryptionStatus = owner.status?.blockEncryption?.status ?? null;
    observed.startupProtectionEnabled = owner.status?.startupProtection?.enabled ?? null;
    observed.startupProtectionMode = owner.status?.startupProtection?.mode ?? null;
    observed.webPassphraseCapable = owner.status?.capabilities?.webPassphrase ?? null;
    observed.transitionStates = (owner.status?.recentTransitions ?? []).map((item) => item.state);
    operations.statusApiAvailable = owner.statusCode === 200 && owner.hasError === false;
    // The active appliance NVMe is intentionally not converted. The retained integration
    // state may describe a disposable volume, but the UI must not claim an encrypted
    // production layout for the current base disk.
    operations.baseDiskTruthful = owner.status?.blockEncryption?.configured === true
      && owner.status?.blockEncryption?.mode === "luks2"
      && owner.status?.blockEncryption?.status === "verified"
      && owner.status?.startupProtection?.enabled === false
      && owner.status?.startupProtection?.mode === "automatic"
      && owner.status?.activeMediaMigration?.performed !== true
      && owner.status?.productionLayout?.encrypted !== true
      && !/(active NVMe encrypted|production layout encrypted|当前 NVMe 已加密)/i.test(owner.panel);
    operations.optionalWebModeVisible = owner.status?.capabilities?.webPassphrase === true
      && /LUKS2/.test(owner.panel) && /Web/.test(owner.panel);
    operations.hardwareKeyAbsent = !Object.hasOwn(owner.status?.capabilities ?? {}, "usbKey")
      && !/(USB Key|SDK)/.test(owner.panel);
    operations.currentTransitionHistoryClean = observed.transitionStates.length === 0;
    operations.auditChainValid = owner.auditCode === 200 && owner.audit?.valid === true;
    operations.factorMaterialNotRendered = !owner.panel.includes("018f0000-0000-7000-8000-000000000021")
      && !owner.panel.includes("018f0000-0000-7000-8000-000000000022")
      && !/(automatic\.key|recovery\.key|web\.key)/.test(owner.panel);
    need(operations.statusApiAvailable && operations.baseDiskTruthful && operations.optionalWebModeVisible
      && operations.hardwareKeyAbsent && operations.currentTransitionHistoryClean
      && operations.auditChainValid && operations.factorMaterialNotRendered,
    "current optional LUKS owner state is incomplete or misleading");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-current-zh-dark", ".encryption-panel"));
    await setPreferences(cdp, { locale: "en", theme: "light" });
    operations.englishLightApplied = true;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openEncryption(cdp, options.origin);
    const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,panel:Boolean(document.querySelector(".encryption-panel")),error:Boolean(document.querySelector(".encryption-state--error"))})`);
    operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en"
      && mobile.theme === "light" && mobile.panel && !mobile.error;
    need(operations.mobileNoOverflow, "current optional LUKS mobile view overflowed or failed");
    screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "owner-current-mobile-en-light", ".encryption-panel"));
    await signIn(cdp, options.origin, accounts.member);
    await cdp.send("Page.navigate", { url: new URL("/admin/encryption", options.origin).href });
    await cdp.wait(`({ready:Boolean(document.querySelector(".admin-access-denied"))})`, "current optional LUKS member denial");
    const member = await cdp.evaluate(`(async()=>{const response=await fetch("/api/v1/admin/encryption/status",{credentials:"same-origin",headers:{accept:"application/json"}}),page=document.querySelector(".admin-access-denied")?.innerText||"";return{status:response.status,adminNav:[...document.querySelectorAll(".nav-item")].some(item=>/管理|Admin/.test(item.textContent)),panel:Boolean(document.querySelector(".encryption-panel")),denial:Boolean(document.querySelector(".admin-access-denied")),ownerClaim:/设备所有者|Appliance owner/.test(page),memberClaim:/(^|\\n)(团队成员|成员|Team member|Member)(\\n|$)/m.test(page)}})()`);
    operations.memberAdminHidden = member.adminNav === false;
    operations.memberApiDenied = member.status === 403;
    operations.memberDirectRouteDenied = member.panel === false && member.denial && !member.ownerClaim && member.memberClaim;
    const launch = JSON.parse(await readFile(options.launchEvidence));
    operations.normalSystemTrustOnly = launch.systemTrustOnly === true
      && launch.certificateBypassArgumentsPresent === false
      && launch.customClientCaArgumentPresent === false;
    need(OPERATIONS.every((key) => operations[key] === true), "one or more current optional LUKS browser operations failed");
    need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    if (browserRuntime) await stopChrome(browserRuntime);
    accounts.owner.password = accounts.member.password = "[REDACTED]";
  }
  const launchBytes = await readFile(options.launchEvidence).catch(() => null);
  const evidence = {
    schemaVersion: 1,
    runnerId: "teamaibox.current-optional-luks-browser.v1",
    runId: options.runId,
    featureKey: "integration.encrypted-unlock",
    status: failure ? "failed" : "passed",
    origin: options.origin,
    startedAt,
    completedAt: new Date().toISOString(),
    browser: browserRuntime?.browser ?? null,
    operations,
    observed,
    screenshots,
    console: { errorCount: browserRuntime?.errors.length ?? 0 },
    source: {
      runnerDigest: digest(await readFile(new URL(import.meta.url))),
      commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))),
    },
    parents: {
      runtime: { path: relative(ROOT, options.runtimeEvidence), runId: runtime.runId,
        evidenceDigest: runtime.evidenceDigest, fileSha256: digest(runtimeBytes) },
      launch: { path: relative(ROOT, options.launchEvidence), fileSha256: launchBytes ? digest(launchBytes) : null },
    },
    privacy: { credentialsRetained: false, factorMaterialRetained: false, userContentRetained: false,
      commandOutputRetained: false, syntheticContentOnly: true },
    claimBoundary: {
      optionalDisposableLuksWebUnlockBrowserAccepted: !failure,
      browserTrustedHttps: !failure,
      activeMediaEncrypted: false,
      activeMediaMigrationPerformed: false,
      hardwareKeyRequired: false,
      independentHumanAcceptance: false,
      formalReleaseAccepted: false,
    },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`current optional LUKS browser failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({runId:evidence.runId,status:evidence.status,operationCount:OPERATIONS.length,screenshotCount:screenshots.length,evidence:relative(ROOT,options.output)})}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "current optional LUKS browser failed"}\n`); process.exitCode = 1; });
