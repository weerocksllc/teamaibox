export type Ecosystem = "pip" | "npm" | "apt";
export type SourceHealth = "unknown" | "healthy" | "degraded" | "offline" | "detached";

export type SoftwareSource = Readonly<{
  sourceId: string; sourceKey: string; displayName: string; ecosystem: Ecosystem;
  kind: "hosted" | "proxy-cache" | "upstream" | "mirror" | "offline-media";
  endpoint: { url: string; networkZone: "internal" | "lan" | "internet" };
  priority: number; packageScopes: string[]; architectures: string[];
  trust: { checksumRequired: true; signaturePolicy: string; tlsRequired: boolean };
  credentialConfigured: boolean; credentialSecretKey: string | null;
  onlineMode: "auto" | "online" | "offline";
  cache: { mode: string; maximumBytes: number; ttlSeconds: number; retainVerified: boolean };
  storagePoolId: string | null; health: { state: SourceHealth; latencyMilliseconds: number | null; errorCode: string | null; observedAt: string | null };
  enabled: boolean; revision: number; updatedAt: string;
}>;

export type SourcePolicy = Readonly<{
  policyId: string; policyKey: string; displayName: string; ecosystem: Ecosystem; environment: string;
  selector: { teamKey: string | null; sandboxProfileKey: string | null; architecture: string };
  offlineMode: string; sources: Array<{ sourceId: string; priority: number }>;
  packageRules: Array<{ pattern: string; decision: string; version: string | null }>;
  enabled: boolean; revision: number;
}>;

export type SourceOverview = Readonly<{
  schemaVersion: 1; sourceCount: number; policyCount: number;
  byEcosystem: Record<Ecosystem, { sources: number; enabled: number; healthy: number; offline: number; policies: number }>;
}>;

export type SourceDataPlanes = Readonly<{
  schemaVersion: 1; state: "ready" | "degraded" | "unavailable"; observedAt: string; errorCode: string | null;
  ecosystems: Record<Ecosystem, { requests: number | null; cacheHits: number | null; upstreamFetches: number | null; upstreamBytes: number | null }>;
}>;

export type OfflineMedia = Readonly<{
  mediaId: string; nodeId: string; filesystemUuid: string; volumeLabel: string; filesystemType: string; transport: string;
  capacityBytes: number; observedManifestSha256: string; availability: "attached" | "detached";
  approvalState: "pending" | "approved"; lifecycleState: "discovered" | "ready" | "detached";
  health: { state: SourceHealth; errorCode: string | null; observedAt: string | null };
  inventory: null | { artifactCount: number; packageCount: number; totalBytes: number; dependencyEdges: number; missingDependencies: unknown[]; complete: boolean; architectures: string[]; ecosystems: Record<Ecosystem, { artifacts: number; packages: number; bytes: number }> };
  approvedBy: string | null; approvedAt: string | null; lastSeenAt: string; revision: number;
}>;

export class SourceCenterApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = "SourceCenterApiError"; }
}

async function accepted(response: Response) {
  let value: any;
  try { value = await response.json(); } catch { throw new SourceCenterApiError("invalid_response", "Source Center returned an invalid response", 502); }
  if (!response.ok) throw new SourceCenterApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Source Center request failed", response.status);
  return value;
}

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new SourceCenterApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(matches[0].slice("__Host-teamaibox-csrf=".length));
}

async function request(path: string, method = "GET", body?: unknown) {
  return accepted(await fetch(path, {
    method, credentials: "same-origin",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

export async function loadSourceCenter() {
  const [overview, dataPlanes, sources, policies, media] = await Promise.all([
    request("/api/v1/admin/source-center/overview"), request("/api/v1/admin/source-center/data-planes"), request("/api/v1/admin/source-center/sources"), request("/api/v1/admin/source-center/policies"), request("/api/v1/admin/source-center/offline-media"),
  ]);
  return { overview: overview as SourceOverview, dataPlanes: dataPlanes as SourceDataPlanes, sources: (sources.data ?? []) as SoftwareSource[], policies: (policies.data ?? []) as SourcePolicy[], media: (media.data ?? []) as OfflineMedia[] };
}

export async function createSoftwareSource(declaration: Record<string, unknown>): Promise<SoftwareSource> {
  return request("/api/v1/admin/source-center/sources", "POST", declaration);
}

export async function updateSoftwareSource(source: SoftwareSource, declaration: Record<string, unknown>): Promise<SoftwareSource> {
  return request(`/api/v1/admin/source-center/sources/${source.sourceId}`, "PATCH", { expectedRevision: source.revision, declaration });
}

export async function createSourcePolicy(declaration: Record<string, unknown>): Promise<SourcePolicy> {
  return request("/api/v1/admin/source-center/policies", "POST", declaration);
}

export async function discoverOfflineMedia(nodeId: string): Promise<{ object: "list"; data: OfflineMedia[] }> {
  return request("/api/v1/admin/source-center/offline-media/discover", "POST", { nodeId });
}

export async function approveOfflineMedia(media: OfflineMedia): Promise<OfflineMedia> {
  return request(`/api/v1/admin/source-center/offline-media/${media.mediaId}/approve`, "POST", { expectedRevision: media.revision, expectedManifestSha256: media.observedManifestSha256 });
}
