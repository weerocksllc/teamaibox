#!/usr/bin/env node
/** Convert the content-safe Translation metric report into the fail-closed suite report. */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateModelQuality, modelQualitySuiteDigest } from "../apps/platform-api/src/models/model-quality-service.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]); return pairs;
}, []));
const required = ["metrics", "output", "corpus-digest", "profile-fingerprint", "baseline-profile-fingerprint"];
for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
const root = resolve(new URL("..", import.meta.url).pathname);
const catalog = JSON.parse(await readFile(resolve(root, "models/quality-suite-catalog.v1.json"), "utf8"));
const suite = catalog.suites.find((value) => value.taskType === "translation");
if (!suite) throw new Error("Translation quality suite is absent");
const metrics = JSON.parse(await readFile(resolve(args.metrics), "utf8"));
if (metrics.corpusDigest !== args["corpus-digest"]
    || metrics.candidateProfileFingerprint !== args["profile-fingerprint"]
    || metrics.baselineProfileFingerprint !== args["baseline-profile-fingerprint"]) {
  throw new Error("metric report identity does not match the requested corpus or profiles");
}
const wantedSlices = new Set(suite.corpus.requiredSlices.map((value) => value.sliceKey));
const result = {
  suiteDigest: modelQualitySuiteDigest(suite),
  corpusDigest: args["corpus-digest"],
  profileFingerprint: args["profile-fingerprint"],
  baselineProfileFingerprint: args["baseline-profile-fingerprint"],
  evaluatorImage: suite.evaluator.image,
  implementationDigest: suite.evaluator.implementationDigest,
  seed: 42,
  caseCount: metrics.caseCount,
  sliceCounts: metrics.sliceCounts.filter((value) => wantedSlices.has(value.sliceKey)),
  measurements: metrics.measurements,
  startedAt: metrics.startedAt,
  finishedAt: metrics.finishedAt,
};
const report = evaluateModelQuality({
  suite, expectedSuiteDigest: result.suiteDigest,
  corpusDigest: result.corpusDigest, profileFingerprint: result.profileFingerprint,
  baselineProfileFingerprint: result.baselineProfileFingerprint, result,
});
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const evidence = {
  schemaVersion: 1,
  runId: args["run-id"] ?? "translation-quality-20260813-qwen36-nvfp4-a1",
  target: "dgx-spark-dev-01",
  inputEvidence: {
    corpusDigest: result.corpusDigest,
    candidateProfileFingerprint: result.profileFingerprint,
    baselineProfileFingerprint: result.baselineProfileFingerprint,
    candidateResultDigest: args["candidate-result-digest"],
    baselineResultDigest: args["baseline-result-digest"],
    metricResultDigest: metrics.resultDigest,
    cometArtifactDigest: args["comet-artifact-digest"],
  },
  suiteReport: report,
  certificationClaimEligible: report.outcome === "passed" && report.failures.length === 0,
  plaintextCasesRetained: false,
  credentialsRetained: false,
};
evidence.evidenceDigest = `sha256:${createHash("sha256").update(canonical(evidence)).digest("hex")}`;
await writeFile(resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ outcome: report.outcome, failures: report.failures.length, reportDigest: report.reportDigest }));
