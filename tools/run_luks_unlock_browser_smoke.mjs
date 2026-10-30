#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { CHROME, canonical, digest, need, setter, shotElement, startChrome, stopChrome } from "./browser_smoke_common.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN_ID = /^luks-unlock-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;
const VOLUME_RUN_ID = /^luks-unlock-integration-[0-9]{8}-[a-z0-9][a-z0-9-]{1,31}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  "lockedStateVisible", "protectedDataClaimVisible", "minimalSurfaceOnly", "selfContainedAssets",
  "tlsSecurityHeadersVisible", "chineseDarkApplied", "englishLightApplied", "wrongFactorGeneric",
  "wrongFactorCleared", "correctFactorAccepted", "unlockedStateVisible", "mobileNoOverflow",
];

function optionsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "LUKS unlock browser arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["origin", "run-id", "deployment-evidence", "unlock-image-id", "volume-run-id", "output", "screenshots"]) need(values[key], `LUKS unlock browser ${key} is required`);
  const origin = new URL(values.origin); need(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password, "LUKS unlock browser origin must be exact HTTPS");
  need(RUN_ID.test(values["run-id"]) && VOLUME_RUN_ID.test(values["volume-run-id"]) && SHA256.test(values["unlock-image-id"]), "LUKS unlock browser identity or image is invalid");
  const result = { origin: origin.href, runId: values["run-id"], deploymentEvidence: resolve(values["deployment-evidence"]), unlockImageId: values["unlock-image-id"], volumeRunId: values["volume-run-id"], output: resolve(values.output), screenshots: resolve(values.screenshots), chrome: values.chrome ?? CHROME };
  for (const path of [result.deploymentEvidence, result.output, result.screenshots]) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "LUKS unlock browser artifact escapes the repository"); }
  return result;
}

async function passphraseFromStdin() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks);
  try { const value = JSON.parse(raw.toString("utf8")); need(typeof value.passphrase === "string" && value.passphrase.length >= 16 && value.passphrase.length <= 4096 && !value.passphrase.includes("\0"), "LUKS Web passphrase is unavailable"); return value.passphrase; }
  finally { raw.fill(0); }
}

async function openUnlock(cdp, origin) {
  await cdp.send("Page.navigate", { url: origin });
  return cdp.wait(`({ready:Boolean(document.querySelector("#form")&&document.querySelector("#state")?.textContent!=="—")})`, "minimal unlock page", 30_000);
}

async function setUi(cdp, { locale, theme }) {
  await cdp.evaluate(`(() => {if(document.documentElement.lang!==${JSON.stringify(locale)})document.querySelector("#locale").click();return true})()`);
  await cdp.wait(`({ready:document.documentElement.lang===${JSON.stringify(locale)}})`, "unlock locale switch");
  await cdp.evaluate(`(() => {if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector("#theme").click();return true})()`);
  await cdp.wait(`({ready:document.documentElement.dataset.theme===${JSON.stringify(theme)}})`, "unlock theme switch");
}

async function main() {
  const options = optionsFrom(process.argv.slice(2)); let passphrase = await passphraseFromStdin();
  await readFile(options.output).then(() => { throw new Error("LUKS unlock browser evidence exists; use a new run ID"); }).catch((error) => { if (error.message?.includes("exists; use")) throw error; if (error.code !== "ENOENT") throw error; });
  const deploymentBytes = await readFile(options.deploymentEvidence), deployment = JSON.parse(deploymentBytes), identity = deployment.runId?.match(/^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/); need(identity, "storage deployment identity is invalid");
  const plan = JSON.parse(await readFile(join(ROOT, "deploy", "application-catalog-e2e", `plan-${identity[1]}-${identity[2]}.json`))); need(deployment.status === "passed" && deployment.featureKey === "admin.storage", "passing Storage deployment is required for LUKS unlock browser integration");
  await mkdir(dirname(options.output), { recursive: true }); await mkdir(options.screenshots, { recursive: false });
  const startedAt = new Date().toISOString(), operations = Object.fromEntries(OPERATION_KEYS.map((key) => [key, false])), screenshots = [];
  let runtime = null, failure = null;
  try {
    runtime = await startChrome(options.chrome); const { cdp, errors } = runtime; await openUnlock(cdp, options.origin);
    const locked = await cdp.evaluate(`(() => {const text=document.body.innerText,links=[...document.querySelectorAll("script[src],link[href]")].map(item=>item.src||item.href);return{state:document.querySelector("#state")?.textContent||"",claim:/LUKS2/.test(text)&&/团队文件|team files/i.test(text),minimal:!document.querySelector(".app-frame,.nav-item")&&document.querySelectorAll("form").length===1,selfContained:links.every(item=>new URL(item).origin===location.origin),headers:null}})()`);
    operations.lockedStateVisible = /已锁定|Locked/i.test(locked.state); operations.protectedDataClaimVisible = locked.claim; operations.minimalSurfaceOnly = locked.minimal; operations.selfContainedAssets = locked.selfContained;
    const headers = await cdp.evaluate(`(async()=>{const r=await fetch("/",{cache:"no-store"});return{status:r.status,hsts:r.headers.get("strict-transport-security"),nosniff:r.headers.get("x-content-type-options"),frame:r.headers.get("x-frame-options")}})()`); operations.tlsSecurityHeadersVisible = headers.status === 200 && headers.hsts === "max-age=31536000" && headers.nosniff === "nosniff" && headers.frame === "DENY";
    need(operations.lockedStateVisible && operations.protectedDataClaimVisible && operations.minimalSurfaceOnly && operations.selfContainedAssets && operations.tlsSecurityHeadersVisible, "minimal locked Web surface drifted");
    await setUi(cdp, { locale: "zh-CN", theme: "dark" }); operations.chineseDarkApplied = true; screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "locked-desktop-zh-dark", ".card"));
    await setUi(cdp, { locale: "en", theme: "light" }); operations.englishLightApplied = true;
    need(await cdp.evaluate(setter("#passphrase", "definitely-wrong-disposable-factor")), "unlock passphrase input is missing"); await cdp.evaluate(`document.querySelector("#form").requestSubmit()`);
    const denied = await cdp.wait(`(() => ({ready:!document.querySelector("#message").hidden&&/incorrect|不正确/i.test(document.querySelector("#message").textContent||""),cleared:document.querySelector("#passphrase").value===""}))()`, "generic wrong-factor denial", 30_000); operations.wrongFactorGeneric = denied.ready; operations.wrongFactorCleared = denied.cleared; need(operations.wrongFactorGeneric && operations.wrongFactorCleared, "wrong factor was not generically denied and cleared");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); const mobile = await cdp.evaluate(`({width:innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),locale:document.documentElement.lang,theme:document.documentElement.dataset.theme})`); operations.mobileNoOverflow = mobile.width === 390 && mobile.scrollWidth <= 390 && mobile.locale === "en" && mobile.theme === "light"; need(operations.mobileNoOverflow, "mobile unlock surface overflowed or lost preferences"); screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "locked-mobile-en-light", ".card"));
    need(await cdp.evaluate(setter("#passphrase", passphrase)), "unlock passphrase input disappeared"); await cdp.evaluate(`document.querySelector("#form").requestSubmit()`); passphrase = "[REDACTED]";
    const accepted = await cdp.wait(`(() => ({ready:!document.querySelector("#message").hidden&&/Verified|验证成功/i.test(document.querySelector("#message").textContent||"")&&document.querySelector("#passphrase").value===""}))()`, "accepted Web unlock", 60_000); operations.correctFactorAccepted = accepted.ready;
    const unlocked = await cdp.wait(`(() => ({ready:/Unlocked|已解锁/i.test(document.querySelector("#state")?.textContent||"")}))()`, "unlocked volume state", 60_000); operations.unlockedStateVisible = unlocked.ready; need(operations.correctFactorAccepted && operations.unlockedStateVisible, "correct Web factor did not unlock the disposable LUKS2 volume");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); screenshots.push(await shotElement(cdp, ROOT, options.screenshots, "unlocked-desktop-en-light", ".card"));
    need(OPERATION_KEYS.every((key) => operations[key] === true), "one or more LUKS unlock browser operations did not pass"); need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (error) { failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) }; }
  finally { passphrase = "[REDACTED]"; if (runtime) await stopChrome(runtime); }
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.luks-unlock-browser-smoke.v1", runId: options.runId, featureKey: "integration.encrypted-unlock", status: failure ? "failed" : "passed", origin: options.origin, startedAt, completedAt: new Date().toISOString(), browser: runtime?.browser ?? null, operations, screenshots, console: { errorCount: runtime?.errors.length ?? 0 }, source: { runnerDigest: digest(await readFile(new URL(import.meta.url))), commonDigest: digest(await readFile(new URL("./browser_smoke_common.mjs", import.meta.url))) }, storageDeployment: { evidencePath: relative(ROOT, options.deploymentEvidence), evidenceDigest: digest(deploymentBytes), runId: deployment.runId, sourceDigest: deployment.sourceDigest }, unlockRuntime: { imageId: options.unlockImageId, volumeRunId: options.volumeRunId, mode: "web_passphrase", targetKind: "disposable-regular-file-luks2" }, privacy: { factorRetained: false, credentialsRetained: false, userContentRetained: false, commandOutputRetained: false, syntheticContentOnly: true }, limitations: { trustedHttps: "not_satisfied_by_self_signed_component_origin", independentHumanAcceptance: "not_performed", activeMediaMigration: "not_performed_disposable_regular_file_luks2_only", usbSdkAndDevice: "not_available_not_claimed" }, failure };
  evidence.evidenceDigest = digest(canonical(evidence)); await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (failure) throw new Error(`LUKS unlock browser smoke failed; evidence: ${relative(ROOT, options.output)}`);
  process.stdout.write(`${JSON.stringify({ runId: evidence.runId, status: evidence.status, operationCount: OPERATION_KEYS.length, screenshotCount: screenshots.length, evidence: relative(ROOT, options.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "LUKS unlock browser smoke failed"}\n`); process.exitCode = 1; });
