import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const SAFE_REF = /^(?:object|evidence):\/\/[A-Za-z0-9/._:-]{1,2000}$/;
const STATES = new Set(["experimental", "validating", "certified", "deprecated", "failed", "revalidation_required"]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function requireViewer(context) {
  if (!context?.permissions?.some((permission) => new Set(["model:view", "model:manage"]).has(permission))) {
    fail("model_viewer_required", "Model viewing permission is required", 403);
  }
}
function freeze(value) { return Object.freeze(structuredClone(value)); }
function safeRefs(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && SAFE_REF.test(value)))].sort();
}
function compatibilityRows(compatibility) {
  const rows = [];
  const add = (section, requirement, value) => {
    if (value === undefined || value === null) return;
    rows.push({ section, requirement, value: Array.isArray(value) ? value.join(", ") : String(value) });
  };
  add("platform", "architectures", compatibility?.architectures);
  add("hardware", "acceleratorFamilies", compatibility?.hardware?.acceleratorFamilies);
  add("hardware", "minimumComputeCapability", compatibility?.hardware?.minimumComputeCapability);
  add("hardware", "minimumCpuCores", compatibility?.hardware?.minimumCpuCores);
  add("hardware", "minimumUnifiedMemoryBytes", compatibility?.hardware?.minimumUnifiedMemoryBytes);
  add("software", "os", compatibility?.software?.os);
  add("software", "kernelRange", compatibility?.software?.kernelRange);
  add("software", "driverRange", compatibility?.software?.driverRange);
  add("software", "cudaRange", compatibility?.software?.cudaRange);
  add("software", "containerToolkitRange", compatibility?.software?.containerToolkitRange);
  return rows;
}
function validationSummary(runs) {
  return runs.map((run) => ({
    runId: run.runId,
    state: run.state,
    environmentDigest: run.environmentDigest ?? null,
    stages: (run.stages ?? []).map((stage) => ({
      stage: stage.stage,
      state: stage.state,
      outcome: stage.result?.outcome ?? null,
      startedAt: stage.result?.startedAt ?? null,
      finishedAt: stage.result?.finishedAt ?? null,
      rawEvidenceRefs: safeRefs((stage.result?.evidence ?? []).map((item) => item.reference)),
    })),
  }));
}
function comparisonSummary(comparisons) {
  return comparisons.map((comparison) => ({
    comparisonKind: comparison.comparisonKind,
    outcome: comparison.outcome,
    candidateProfileKey: comparison.candidate?.profileKey ?? null,
    referenceProfileKey: comparison.reference?.profileKey ?? null,
    comparability: comparison.comparability?.workloadDigest ? {
      workloadDigest: comparison.comparability.workloadDigest,
      environmentDigest: comparison.comparability.environmentDigest ?? null,
    } : null,
    quality: comparison.quality ?? null,
    stability: comparison.stability ?? null,
    performance: comparison.performance ? {
      coldLoadTimeMsMedian: comparison.performance.coldLoadTimeMsMedian ?? null,
      peakHostUnifiedMemoryUsedBytes: comparison.performance.peakHostUnifiedMemoryUsedBytes ?? null,
      minimumHostAvailableMemoryBytes: comparison.performance.minimumHostAvailableMemoryBytes ?? null,
      scenarios: comparison.performance.scenarios ?? [],
    } : null,
    certificationClaimEligible: comparison.certificationClaimEligible === true,
    claimBoundary: comparison.claimBoundary ?? null,
    rawEvidenceRefs: safeRefs(comparison.rawEvidenceRefs ?? []),
  }));
}
function recommendation(state, precision, comparisons) {
  if (state === "certified") {
    const favorable = precision === "nvfp4" && comparisons.some((item) =>
      item.outcome === "passed" && item.comparisonKind?.includes("nvfp4-versus"));
    return {
      recommendationKey: favorable ? "model.routing.prefer_certified_nvfp4" : "model.routing.certified_eligible",
      productionEligible: true,
      allowedEnvironments: ["production", "validation", "development"],
      reasonKeys: favorable ? ["model.routing.quality_passed", "model.routing.resource_advantage"] : ["model.routing.certification_passed"],
    };
  }
  if (state === "experimental") return {
    recommendationKey: "model.routing.experimental_opt_in_only", productionEligible: false,
    allowedEnvironments: ["validation", "development"], reasonKeys: ["model.routing.not_certified", "model.routing.admin_opt_in_required"],
  };
  if (state === "validating") return {
    recommendationKey: "model.routing.validation_in_progress", productionEligible: false,
    allowedEnvironments: [], reasonKeys: ["model.routing.validation_incomplete"],
  };
  if (state === "revalidation_required") return {
    recommendationKey: "model.routing.revalidation_required", productionEligible: false,
    allowedEnvironments: [], reasonKeys: ["model.routing.environment_changed"],
  };
  return {
    recommendationKey: state === "deprecated" ? "model.routing.deprecated" : "model.routing.failed",
    productionEligible: false, allowedEnvironments: [], reasonKeys: [`model.routing.${state}`],
  };
}

export class ModelReportService {
  #catalog;
  #clock;
  constructor({ catalog, clock = () => new Date() }) {
    const methods = ["getProfile", "getLifecycle", "listValidationRuns", "listComparisons"];
    if (!catalog || methods.some((method) => typeof catalog[method] !== "function")) throw new TypeError("model report catalog is incomplete");
    this.#catalog = catalog;
    this.#clock = clock;
  }

  async generateCard({ context, profileKey }) {
    requireViewer(context);
    if (!KEY.test(profileKey ?? "")) fail("model_report_input_invalid", "Model profile key is invalid");
    const registration = await this.#catalog.getProfile(profileKey);
    if (!registration?.profile) fail("model_profile_not_found", "Model profile was not found", 404);
    const profile = registration.profile;
    const lifecycle = await this.#catalog.getLifecycle(profile.profileId);
    if (!lifecycle || !STATES.has(lifecycle.state)) fail("model_report_evidence_incomplete", "Model lifecycle evidence is unavailable", 409);
    const runs = await this.#catalog.listValidationRuns(profileKey);
    const comparisons = await this.#catalog.listComparisons(profileKey);
    if (!Array.isArray(runs) || !Array.isArray(comparisons)) fail("model_report_evidence_incomplete", "Model validation evidence is invalid", 409);
    const summarizedRuns = validationSummary(runs);
    const summarizedComparisons = comparisonSummary(comparisons);
    const rawRunLinks = safeRefs([
      ...(profile.validationEvidence ?? []).map((item) => item.evidenceRef),
      ...summarizedRuns.flatMap((run) => run.stages.flatMap((stage) => stage.rawEvidenceRefs)),
      ...summarizedComparisons.flatMap((comparison) => comparison.rawEvidenceRefs),
      ...(lifecycle.evidenceRefs ?? []),
    ]);
    return freeze({
      schemaVersion: 1,
      generatedAt: this.#clock().toISOString(),
      profile: {
        profileId: profile.profileId, profileKey: profile.profileKey,
        fingerprint: registration.fingerprint, sourceModel: profile.source?.model,
        sourceRevision: profile.source?.revision, engine: profile.engine?.name,
        engineVersion: profile.engine?.version, engineImageDigest: profile.engine?.imageDigest,
        precision: profile.precision, artifactDigest: profile.artifactDigest,
        apiContracts: profile.apiContracts ?? [], limits: profile.limits ?? {},
        resourceEnvelope: profile.resourceEnvelope ?? {}, exclusive: profile.exclusive === true,
      },
      lifecycle: {
        state: lifecycle.state, revision: lifecycle.revision,
        reasonKey: lifecycle.reasonKey, validationRunId: lifecycle.validationRunId ?? null,
        updatedAt: new Date(lifecycle.updatedAt).toISOString(),
      },
      compatibilityMatrix: compatibilityRows(profile.compatibility),
      validationRuns: summarizedRuns,
      comparisons: summarizedComparisons,
      knownLimitations: [...new Set(profile.knownLimitations ?? [])],
      routingRecommendation: recommendation(lifecycle.state, profile.precision, summarizedComparisons),
      rawRunLinks,
    });
  }
}

export function renderModelCardMarkdown(card, locale = "zh-CN") {
  if (!card?.profile || !card?.lifecycle || !card?.routingRecommendation) throw new TypeError("model card is invalid");
  const zh = locale === "zh-CN";
  const lines = [
    `# ${card.profile.profileKey}`,
    "",
    `${zh ? "状态" : "State"}: **${card.lifecycle.state}**`,
    `${zh ? "精度" : "Precision"}: ${card.profile.precision}`,
    `${zh ? "引擎" : "Engine"}: ${card.profile.engine} ${card.profile.engineVersion}`,
    `${zh ? "生产路由" : "Production routing"}: ${card.routingRecommendation.productionEligible ? (zh ? "允许" : "Eligible") : (zh ? "禁止" : "Blocked")}`,
    "",
    `## ${zh ? "环境兼容矩阵" : "Environment compatibility"}`,
    "",
    `| ${zh ? "范围" : "Scope"} | ${zh ? "要求" : "Requirement"} | ${zh ? "值" : "Value"} |`,
    "|---|---|---|",
    ...card.compatibilityMatrix.map((row) => `| ${row.section} | ${row.requirement} | ${row.value} |`),
    "",
    `## ${zh ? "已知限制" : "Known limitations"}`,
    "",
    ...(card.knownLimitations.length ? card.knownLimitations.map((item) => `- ${item}`) : [`- ${zh ? "无已记录限制" : "No recorded limitations"}`]),
    "",
    `## ${zh ? "路由建议" : "Routing recommendation"}`,
    "",
    `- ${card.routingRecommendation.recommendationKey}`,
    ...card.routingRecommendation.reasonKeys.map((key) => `- ${key}`),
    "",
    `## ${zh ? "原始运行证据" : "Raw run evidence"}`,
    "",
    ...(card.rawRunLinks.length ? card.rawRunLinks.map((item) => `- ${item}`) : [`- ${zh ? "暂无" : "None"}`]),
    "",
  ];
  return lines.join("\n");
}
