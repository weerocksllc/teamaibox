import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FeatureBrowserAcceptanceError,
  validateFeatureBrowserPlan,
} from "../../../tools/run_feature_browser_acceptance.mjs";

const planPath = new URL(
  "../../../deploy/browser-runner-canary/browser-plan-20260812-a13.json",
  import.meta.url,
);

async function loadPlan() {
  return JSON.parse(await readFile(planPath, "utf8"));
}

test("browser acceptance canary plan is complete and non-release evidence", async () => {
  const { plan } = await validateFeatureBrowserPlan(await loadPlan());
  assert.equal(plan.classification, "component-canary-http");
  assert.equal(plan.releaseEvidenceEligible, false);
  assert.deepEqual(plan.accounts.map(({ key }) => key), ["owner", "ordinary-user"]);
  assert.deepEqual(plan.matrix.locales, ["zh-CN", "en"]);
  assert.deepEqual(plan.matrix.themes, ["light", "dark"]);
  assert.deepEqual(plan.matrix.viewports.map(({ key }) => key), ["desktop", "mobile"]);
});

test("browser acceptance rejects an unknown feature", async () => {
  const plan = await loadPlan();
  plan.featureKey = "application.not-in-catalog";
  await assert.rejects(
    validateFeatureBrowserPlan(plan),
    (error) => error instanceof FeatureBrowserAcceptanceError
      && /feature is unknown/.test(error.message),
  );
});

test("browser acceptance rejects dishonest release eligibility", async () => {
  const plan = await loadPlan();
  plan.releaseEvidenceEligible = true;
  await assert.rejects(
    validateFeatureBrowserPlan(plan),
    (error) => error instanceof FeatureBrowserAcceptanceError
      && /release eligibility is dishonest/.test(error.message),
  );
});

test("browser acceptance rejects a changed upload fixture digest", async () => {
  const plan = await loadPlan();
  plan.artifacts.uploadDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    validateFeatureBrowserPlan(plan),
    (error) => error instanceof FeatureBrowserAcceptanceError
      && /upload fixture digest changed/.test(error.message),
  );
});

test("browser acceptance rejects artifacts outside the repository", async () => {
  const plan = await loadPlan();
  plan.artifacts.screenshotDirectory = "/tmp/teamaibox-browser-artifacts";
  await assert.rejects(
    validateFeatureBrowserPlan(plan),
    (error) => error instanceof FeatureBrowserAcceptanceError
      && /escape the repository/.test(error.message),
  );
});
