export type ModelLifecycleState =
  | "experimental"
  | "validating"
  | "certified"
  | "deprecated"
  | "failed"
  | "revalidation_required";

export type ModelProfileSummary = Readonly<{
  profileId: string;
  profileKey: string;
  fingerprint: string;
  state: ModelLifecycleState;
  revision: number;
  reasonKey: string;
  evidenceRefs: string[];
  validationRunId: string | null;
  updatedAt: string;
}>;

export type ModelCard = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  profile: {
    profileId: string;
    profileKey: string;
    fingerprint: string;
    sourceModel?: string;
    sourceRevision?: string;
    engine?: string;
    engineVersion?: string;
    engineImageDigest?: string;
    precision: string;
    artifactDigest: string;
    apiContracts: string[];
    limits: Record<string, unknown>;
    resourceEnvelope: Record<string, unknown>;
    exclusive: boolean;
  };
  lifecycle: {
    state: ModelLifecycleState;
    revision: number;
    reasonKey: string;
    validationRunId: string | null;
    updatedAt: string;
  };
  compatibilityMatrix: Array<{ section: "platform" | "hardware" | "software"; requirement: string; value: string }>;
  validationRuns: Array<{
    runId: string;
    state: string;
    environmentDigest: string | null;
    stages: Array<{ stage: string; state: string; outcome: string | null; rawEvidenceRefs: string[] }>;
  }>;
  comparisons: Array<{
    comparisonKind: string;
    outcome: string;
    candidateProfileKey: string | null;
    referenceProfileKey: string | null;
    comparability: { workloadDigest: string; environmentDigest: string | null } | null;
    performance: Record<string, unknown> | null;
    certificationClaimEligible: boolean;
    claimBoundary: string | null;
    rawEvidenceRefs: string[];
  }>;
  knownLimitations: string[];
  routingRecommendation: {
    recommendationKey: string;
    productionEligible: boolean;
    allowedEnvironments: Array<"production" | "validation" | "development">;
    reasonKeys: string[];
  };
  rawRunLinks: string[];
}>;

export type RuntimeMetric = Readonly<{
  status: "measured" | "partial" | "configured" | "unsupported" | "unavailable" | "stale";
  value: number | null;
  reasonCode?: string | null;
}>;

export type ModelRuntimeFacts = Readonly<{
  generatedAt: string;
  collectionStatus: "fresh" | "partial" | "stale" | "unavailable";
  deviceAvailable: boolean;
  models: Array<{
    nodeId: string | null;
    nodeKey: string | null;
    nodeFreshness: "fresh" | "stale" | "missing" | null;
    state: string;
    workerId: string | null;
    unifiedMemoryBytes: RuntimeMetric;
    loadMilliseconds: RuntimeMetric;
  }>;
  workers: Array<{
    nodeId: string | null;
    nodeKey: string | null;
    nodeFreshness: "fresh" | "stale" | "missing" | null;
    workerId: string;
    state: string;
    jobId: string | null;
    unifiedMemoryBytes: RuntimeMetric;
    acceleratorUtilizationPercent: RuntimeMetric;
  }>;
  externalMappings: Array<{
    providerId: string;
    providerKey: string;
    displayName: string;
    lifecycleState: string;
    healthState: string;
    freshness: "fresh" | "stale" | "missing";
    operations: string[];
    contextWindow: number;
    enabled: boolean;
  }>;
}>;

export type ExperimentalRoutingPolicy = Readonly<{
  policyKey: string;
  environment: "validation";
  experimentalProfileIds: string[];
}>;

export type ExperimentalRoutingRecord = Readonly<{
  policyKey: string;
  environment: "validation";
  profileId: string;
  enabled: boolean;
  reasonKey: string;
  revision: number;
  expiresAt: string;
  updatedAt: string;
}>;

export class ModelAdminApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ModelAdminApiError";
    this.code = code;
    this.status = status;
  }
}

async function acceptedJson(response: Response) {
  let value: any;
  try {
    value = await response.json();
  } catch {
    throw new ModelAdminApiError("invalid_response", "Model service returned an invalid response", 502);
  }
  if (!response.ok) {
    throw new ModelAdminApiError(
      typeof value?.error?.code === "string" ? value.error.code : "request_failed",
      typeof value?.error?.message === "string" ? value.error.message : "Model request failed",
      response.status,
    );
  }
  return value;
}

async function getJson(path: string) {
  return acceptedJson(await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }));
}

function csrfToken() {
  const values = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new ModelAdminApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}

async function putJson(path: string, body: unknown) {
  return acceptedJson(await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
    },
    body: JSON.stringify(body),
  }));
}

export async function listModelProfiles(): Promise<ModelProfileSummary[]> {
  const result = await getJson("/api/v1/admin/model-profiles?limit=200");
  return Array.isArray(result?.data) ? result.data : [];
}

export async function getModelCard(profileKey: string): Promise<ModelCard> {
  return getJson(`/api/v1/admin/model-profiles/by-key/${encodeURIComponent(profileKey)}/card`);
}

export async function getModelRuntimeFacts(profileId: string): Promise<ModelRuntimeFacts> {
  const dashboard = await getJson("/api/v1/admin/appliance");
  const appliance = dashboard?.appliance;
  const metrics = appliance?.metrics;
  return {
    generatedAt: dashboard.generatedAt,
    collectionStatus: appliance?.collectionStatus ?? "unavailable",
    deviceAvailable: appliance?.collectionStatus === "fresh",
    models: (metrics?.models ?? [])
      .filter((item: any) => item.profileId === profileId)
      .map((item: any) => ({
        nodeId: appliance?.deviceId ?? null,
        nodeKey: appliance?.displayName ?? null,
        nodeFreshness: metrics?.freshness?.status ?? null,
        state: item.state,
        workerId: item.workerId ?? null,
        unifiedMemoryBytes: item.unifiedMemoryBytes,
        loadMilliseconds: item.loadMilliseconds,
      })),
    workers: (metrics?.workers ?? [])
      .filter((item: any) => item.profileId === profileId)
      .map((item: any) => ({
        nodeId: appliance?.deviceId ?? null,
        nodeKey: appliance?.displayName ?? null,
        nodeFreshness: metrics?.freshness?.status ?? null,
        workerId: item.workerId,
        state: item.state,
        jobId: item.jobId ?? null,
        unifiedMemoryBytes: item.unifiedMemoryBytes,
        acceleratorUtilizationPercent: item.acceleratorUtilizationPercent,
      })),
    externalMappings: (dashboard?.externalProviders?.data ?? []).flatMap((provider: any) =>
      (provider.modelMappings ?? [])
        .filter((mapping: any) => mapping.modelProfileId === profileId)
        .map((mapping: any) => ({
          providerId: provider.providerId,
          providerKey: provider.providerKey,
          displayName: provider.displayName,
          lifecycleState: provider.lifecycleState,
          healthState: provider.health?.state ?? "unknown",
          freshness: provider.freshness?.status ?? "missing",
          operations: Array.isArray(mapping.operations) ? mapping.operations : [],
          contextWindow: Number(mapping.contextWindow ?? 0),
          enabled: Boolean(mapping.enabled),
        }))),
  };
}

export async function getExperimentalValidationPolicy(policyKey = "validation.default"): Promise<ExperimentalRoutingPolicy> {
  return getJson(`/api/v1/admin/model-routing-policies/${encodeURIComponent(policyKey)}/experimental-profiles?environment=validation`);
}

export async function setExperimentalValidationRouting({
  profileId,
  enabled,
  policyKey = "validation.default",
}: {
  profileId: string;
  enabled: boolean;
  policyKey?: string;
}): Promise<ExperimentalRoutingRecord> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  return putJson(`/api/v1/admin/model-routing-policies/${encodeURIComponent(policyKey)}/experimental-profiles/${encodeURIComponent(profileId)}`, {
    environment: "validation",
    enabled,
    reasonKey: "model.routing.experimental_validation",
    expiresAt,
  });
}
