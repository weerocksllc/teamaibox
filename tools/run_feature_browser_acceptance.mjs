import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const POLICY_PATH = join(ROOT, "architecture/validation/feature-browser-acceptance-runner.v1.json");
const CATALOG_PATH = join(ROOT, "architecture/validation/feature-acceptance-catalog.v1.json");
const SHA = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^browser-feature-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/;

export class FeatureBrowserAcceptanceError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new FeatureBrowserAcceptanceError(message); };
const canonicalDeep = (value) => Buffer.from(JSON.stringify(sortValue(value)));
const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])) : value;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = () => new Date().toISOString();
const insideRoot = (path) => { const value = relative(ROOT, resolve(path)); return value !== ".." && !value.startsWith("../") && !isAbsolute(value); };

async function loadJson(path) { return JSON.parse(await readFile(path, "utf8")); }

export async function validateFeatureBrowserPlan(plan) {
  const policy = await loadJson(POLICY_PATH);
  const catalog = await loadJson(CATALOG_PATH);
  const fields = new Set(["schemaVersion","runnerId","runId","featureKey","origin","classification","releaseEvidenceEligible","deployment","accounts","matrix","selectors","artifacts","privacy"]);
  requireValue(Object.keys(plan).length === fields.size && Object.keys(plan).every((key) => fields.has(key)), "browser acceptance plan fields drifted");
  requireValue(plan.schemaVersion === 1 && plan.runnerId === policy.runnerId && RUN_ID.test(plan.runId), "browser acceptance plan identity is invalid");
  requireValue(catalog.features.some((item) => item.key === plan.featureKey), "browser acceptance plan feature is unknown");
  const origin = new URL(plan.origin);
  requireValue(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "browser acceptance origin is unsafe");
  requireValue(["component-canary-http", "supported-appliance-authenticated-https"].includes(plan.classification), "browser acceptance classification is invalid");
  requireValue(plan.releaseEvidenceEligible === (plan.classification === "supported-appliance-authenticated-https"), "browser acceptance release eligibility is dishonest");
  requireValue(policy.deploymentBindingRequired === true, "browser deployment binding policy drifted");
  const deploymentFields = ["evidenceDigest","evidencePath","imageId","planDigest","planPath","runId"];
  requireValue(plan.deployment && Object.keys(plan.deployment).sort().join() === deploymentFields.sort().join(), "browser deployment binding fields drifted");
  const deploymentEvidencePath = resolve(plan.deployment.evidencePath);
  const deploymentPlanPath = resolve(plan.deployment.planPath);
  requireValue(insideRoot(deploymentEvidencePath) && insideRoot(deploymentPlanPath), "browser deployment binding escapes the repository");
  const deploymentEvidenceBytes = await readFile(deploymentEvidencePath);
  const deploymentPlanBytes = await readFile(deploymentPlanPath);
  const deploymentEvidence = JSON.parse(deploymentEvidenceBytes);
  const deploymentPlan = JSON.parse(deploymentPlanBytes);
  requireValue(SHA.test(plan.deployment.evidenceDigest) && digest(deploymentEvidenceBytes) === plan.deployment.evidenceDigest, "browser deployment evidence digest changed");
  requireValue(SHA.test(plan.deployment.planDigest) && digest(canonicalDeep(deploymentPlan)) === plan.deployment.planDigest, "browser deployment plan digest changed");
  requireValue(SHA.test(plan.deployment.imageId), "browser deployment image identity is invalid");
  requireValue(deploymentEvidence.status === "passed" && deploymentEvidence.failure === null && deploymentEvidence.runId === plan.deployment.runId && deploymentEvidence.featureKey === plan.featureKey, "browser deployment evidence did not pass or names a different feature");
  requireValue(deploymentEvidence.planDigest === plan.deployment.planDigest && deploymentEvidence.imageBindings?.some((item) => item.imageId === plan.deployment.imageId), "browser deployment plan or image binding drifted");
  requireValue(Array.isArray(plan.accounts) && plan.accounts.map((item) => item.key).join() === policy.requiredAccountKeys.join(), "browser acceptance account coverage drifted");
  for (const account of plan.accounts) {
    requireValue(Object.keys(account).sort().join() === ["expectedIdentity","key","passwordSecret","role","username"].sort().join(), `browser account ${account.key} fields drifted`);
    requireValue(/^[a-z][a-z0-9-]{1,31}$/.test(account.username) && /^[A-Z][A-Z0-9_]{2,63}$/.test(account.passwordSecret), `browser account ${account.key} credentials declaration is invalid`);
    requireValue(account.expectedIdentity.includes(account.role), `browser account ${account.key} expected role is unbound`);
  }
  requireValue(plan.matrix.locales.join() === policy.requiredLocales.join() && plan.matrix.themes.join() === policy.requiredThemes.join(), "browser locale/theme matrix drifted");
  requireValue(plan.matrix.viewports.map((item) => item.key).join() === policy.requiredViewportKeys.join(), "browser viewport matrix drifted");
  for (const viewport of plan.matrix.viewports) requireValue(Number.isInteger(viewport.width) && Number.isInteger(viewport.height) && viewport.width >= 320 && viewport.height >= 568, `browser viewport ${viewport.key} is invalid`);
  const selectors = ["username","password","signIn","workspace","identity","locale","theme","uploadInput","uploadButton","uploadStatus","download","sse","websocket","transportStatus","signOut"];
  requireValue(Object.keys(plan.selectors).sort().join() === selectors.sort().join() && Object.values(plan.selectors).every((item) => /^[a-z][a-z0-9-]+$/.test(item)), "browser selector contract drifted");
  requireValue(insideRoot(plan.artifacts.screenshotDirectory) && insideRoot(plan.artifacts.uploadFixture), "browser artifacts escape the repository");
  const upload = await readFile(resolve(plan.artifacts.uploadFixture));
  requireValue(SHA.test(plan.artifacts.uploadDigest) && digest(upload) === plan.artifacts.uploadDigest, "browser upload fixture digest changed");
  requireValue(JSON.stringify(plan.privacy) === JSON.stringify(policy.artifactPolicy), "browser artifact privacy policy drifted");
  return { plan, policy, catalog, deploymentEvidence };
}

function testId(tab, plan, key) { return tab.playwright.getByTestId(plan.selectors[key]); }
async function expectText(locator, expected, label) {
  await locator.waitFor({ state: "visible", timeoutMs: 10000 });
  const text = await locator.innerText({ timeoutMs: 10000 });
  requireValue(text.includes(expected), `${label} did not contain the expected text`);
}

async function accessibilityAudit(tab, locale, theme) {
  return tab.playwright.evaluate(({ locale, theme }) => {
    const named = (element) => (element.getAttribute("aria-label") || element.textContent || "").trim();
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const controls = [...document.querySelectorAll("input,select,textarea")];
    const violations = [];
    if (document.documentElement.lang !== locale) violations.push("document-language");
    if (document.documentElement.dataset.theme !== theme) violations.push("effective-theme");
    if (!document.querySelector("main")) violations.push("main-landmark");
    if (new Set(ids).size !== ids.length) violations.push("unique-ids");
    if ([...document.querySelectorAll("button")].some((element) => !named(element))) violations.push("named-buttons");
    if (controls.some((element) => !element.closest("label") && !element.getAttribute("aria-label") && !element.getAttribute("aria-labelledby"))) violations.push("labelled-inputs");
    const focusRules = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules].map((rule) => rule.cssText); } catch { return []; } });
    if (!focusRules.some((rule) => rule.includes(":focus-visible") && rule.includes("outline"))) violations.push("visible-focus-style");
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    if (scrollWidth > innerWidth) violations.push("no-horizontal-overflow");
    const contentWidth = Math.round(document.querySelector('[data-testid="workspace-title"]')?.parentElement?.getBoundingClientRect().width ?? 0);
    const minimumContentWidth = Math.min(innerWidth - (innerWidth <= 520 ? 28 : 64), 836);
    if (contentWidth < minimumContentWidth) violations.push("usable-content-width");
    const localeControlWidth = Math.round(document.querySelector('[data-testid="locale"]')?.getBoundingClientRect().width ?? 0);
    const themeControlWidth = Math.round(document.querySelector('[data-testid="theme"]')?.getBoundingClientRect().width ?? 0);
    const uploadControlWidth = Math.round(document.querySelector('[data-testid="upload-input"]')?.getBoundingClientRect().width ?? 0);
    if (localeControlWidth < 110 || themeControlWidth < 110 || uploadControlWidth < Math.min(240, contentWidth - 36)) violations.push("usable-control-width");
    return { violations, width: innerWidth, scrollWidth, contentWidth, localeControlWidth, themeControlWidth, uploadControlWidth, language: document.documentElement.lang, theme: document.documentElement.dataset.theme };
  }, { locale, theme });
}

export async function runFeatureBrowserAcceptance({ browser, viewportCapability, plan, secrets, outputPath }) {
  const validated = await validateFeatureBrowserPlan(plan);
  const policy = validated.policy;
  const absoluteOutput = resolve(outputPath);
  requireValue(insideRoot(absoluteOutput), "browser acceptance evidence escapes the repository");
  await readFile(absoluteOutput).then(() => { throw new FeatureBrowserAcceptanceError("browser acceptance evidence already exists; use a new run ID"); }).catch((error) => { if (error instanceof FeatureBrowserAcceptanceError) throw error; if (error.code !== "ENOENT") throw error; });
  const screenshotDirectory = resolve(plan.artifacts.screenshotDirectory);
  const startedAt = now();
  const matrix = [];
  const journeys = [];
  let tab;
  let failure = null;
  let browserIdentity = null;
  let uploadCount = 0;
  let downloadCount = 0;
  let sseCount = 0;
  let websocketCount = 0;
  try {
    await mkdir(dirname(screenshotDirectory), { recursive: true });
    await mkdir(screenshotDirectory, { recursive: false }).catch((error) => {
      if (error.code === "EEXIST") throw new FeatureBrowserAcceptanceError("browser screenshot directory already exists; use a new run ID");
      throw error;
    });
    tab = await browser.tabs.new();
    await browser.nameSession(`Team AI Box ${plan.runId}`);
    for (const account of plan.accounts) {
      const password = secrets?.[account.passwordSecret];
      requireValue(typeof password === "string" && password.length >= 8, `browser account ${account.key} secret is unavailable`);
      for (const viewport of plan.matrix.viewports) for (const locale of plan.matrix.locales) for (const theme of plan.matrix.themes) {
        const combination = `${account.key}.${viewport.key}.${locale}.${theme}`;
        const steps = [];
        await viewportCapability.set({ width: viewport.width, height: viewport.height });
        await tab.goto(plan.origin);
        steps.push({ step: "navigate", passed: true });
        const sessionIsVisible = await tab.playwright.evaluate((testId) => {
          const element = document.querySelector(`[data-testid="${testId}"]`);
          return Boolean(element && !element.closest("[hidden]"));
        }, plan.selectors.signOut);
        if (sessionIsVisible) {
          await tab.playwright.expectNavigation(() => testId(tab, plan, "signOut").click(), { waitUntil: "domcontentloaded", timeoutMs: 10000 });
          await testId(tab, plan, "username").waitFor({ state: "visible", timeoutMs: 10000 });
        }
        await testId(tab, plan, "username").fill(account.username);
        await testId(tab, plan, "password").fill(password);
        await testId(tab, plan, "signIn").click();
        await expectText(testId(tab, plan, "identity"), account.expectedIdentity, `${combination} identity`);
        steps.push({ step: "sign-in", passed: true }, { step: "role-boundary", passed: true });
        await testId(tab, plan, "locale").selectOption(locale);
        await testId(tab, plan, "theme").selectOption(theme);
        steps.push({ step: "locale", passed: true }, { step: "theme", passed: true });
        if (locale === plan.matrix.locales[0] && theme === plan.matrix.themes[0] && viewport.key === plan.matrix.viewports[0].key) {
          const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 });
          await testId(tab, plan, "uploadInput").click();
          const chooser = await chooserPromise;
          requireValue(!chooser.isMultiple(), `${combination} upload unexpectedly accepted multiple files`);
          await chooser.setFiles(resolve(plan.artifacts.uploadFixture), { timeoutMs: 10000 });
          await testId(tab, plan, "uploadButton").click();
          await expectText(testId(tab, plan, "uploadStatus"), "upload-ok", `${combination} upload`);
          uploadCount += 1;
          const downloadPromise = tab.playwright.waitForEvent("download", { timeoutMs: 10000 });
          await testId(tab, plan, "download").click();
          await downloadPromise;
          downloadCount += 1;
        }
        steps.push({ step: "upload", passed: true }, { step: "download", passed: true });
        await testId(tab, plan, "sse").click();
        await expectText(testId(tab, plan, "transportStatus"), "sse-ok", `${combination} SSE`);
        sseCount += 1;
        await testId(tab, plan, "websocket").click();
        await expectText(testId(tab, plan, "transportStatus"), "websocket-ok", `${combination} WebSocket`);
        websocketCount += 1;
        steps.push({ step: "sse", passed: true }, { step: "websocket", passed: true });
        await tab.reload();
        await expectText(testId(tab, plan, "identity"), account.expectedIdentity, `${combination} reload identity`);
        steps.push({ step: "reload-persistence", passed: true });
        const accessibility = await accessibilityAudit(tab, locale, theme);
        requireValue(accessibility.violations.length === 0 && accessibility.width === viewport.width && accessibility.scrollWidth <= viewport.width, `${combination} accessibility or viewport audit failed: ${accessibility.violations.join(",")}`);
        steps.push({ step: "accessibility", passed: true });
        const screenshot = await tab.screenshot({ fullPage: true });
        const screenshotBytes = Buffer.from(screenshot);
        const screenshotExtension = screenshotBytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
          ? "png"
          : screenshotBytes.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])) ? "jpg" : null;
        requireValue(screenshotExtension !== null, `${combination} screenshot format is unsupported`);
        const screenshotName = `${combination}.${screenshotExtension}`;
        const screenshotPath = join(screenshotDirectory, screenshotName);
        await writeFile(screenshotPath, screenshotBytes);
        const screenshotDigest = digest(screenshotBytes);
        steps.push({ step: "screenshot", passed: true });
        if (browserIdentity === null) browserIdentity = await tab.playwright.evaluate(() => ({
          userAgent: document.defaultView?.navigator?.userAgent ?? "unavailable",
          platform: document.defaultView?.navigator?.platform ?? "unavailable",
        }));
        await tab.playwright.expectNavigation(() => testId(tab, plan, "signOut").click(), { waitUntil: "domcontentloaded", timeoutMs: 10000 });
        await testId(tab, plan, "username").waitFor({ state: "visible", timeoutMs: 10000 });
        steps.push({ step: "sign-out", passed: true });
        const expectedSteps = policy.requiredJourneySteps;
        requireValue(expectedSteps.every((step) => steps.some((item) => item.step === step && item.passed)), `${combination} journey coverage is incomplete`);
        matrix.push({ combination, account: account.key, role: account.role, viewport: viewport.key, width: accessibility.width, scrollWidth: accessibility.scrollWidth, contentWidth: accessibility.contentWidth, localeControlWidth: accessibility.localeControlWidth, themeControlWidth: accessibility.themeControlWidth, uploadControlWidth: accessibility.uploadControlWidth, locale: accessibility.language, theme: accessibility.theme, screenshot: { path: relative(ROOT, screenshotPath), digest: screenshotDigest }, result: "passed" });
        journeys.push({ combination, steps });
      }
    }
    const logs = await tab.dev.logs({ levels: ["error"], limit: 100 });
    requireValue(logs.length === 0, `browser emitted ${logs.length} console errors`);
  } catch (error) {
    failure = { type: error?.constructor?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    await viewportCapability.reset().catch(() => {});
  }
  const result = {
    schemaVersion: 1,
    runnerId: plan.runnerId,
    runId: plan.runId,
    featureKey: plan.featureKey,
    status: failure === null ? "passed" : "failed",
    releaseEvidenceEligible: plan.releaseEvidenceEligible,
    classification: plan.classification,
    origin: plan.origin,
    startedAt,
    completedAt: now(),
    browser: browserIdentity,
    matrix,
    journeys,
    operations: { uploadCount, downloadCount, sseCount, websocketCount },
    privacy: plan.privacy,
    source: {
      planDigest: digest(canonicalDeep(plan)),
      policyDigest: digest(await readFile(POLICY_PATH)),
      catalogDigest: digest(await readFile(CATALOG_PATH)),
      runnerDigest: digest(await readFile(new URL(import.meta.url))),
      uploadDigest: plan.artifacts.uploadDigest,
      deploymentEvidenceDigest: plan.deployment.evidenceDigest,
      deploymentPlanDigest: plan.deployment.planDigest,
      deploymentImageId: plan.deployment.imageId,
      deploymentRunId: plan.deployment.runId,
    },
    failure,
  };
  result.evidenceDigest = digest(canonicalDeep(result));
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (failure !== null) throw new FeatureBrowserAcceptanceError(`browser acceptance failed; evidence: ${relative(ROOT, absoluteOutput)}`);
  return { ...result, evidence: relative(ROOT, absoluteOutput), tab };
}
