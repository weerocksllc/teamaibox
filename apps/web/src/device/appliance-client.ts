import { loadDiagnosticPages } from "./diagnostic-pages.mjs";

export type MetricStatus = "measured" | "partial" | "configured" | "unsupported" | "unavailable" | "stale";
export type DashboardMetric = Readonly<{ status: MetricStatus; value: number | null; reasonCode?: string | null; effectiveStatus?: MetricStatus }>;
export type MetricDomains = Readonly<Record<string, Readonly<Record<string, DashboardMetric>>>>;
export type DeviceMetricView = Readonly<{
  nodeId: string; nodeGeneration: number; sequence: number; observedAt: string; receivedAt: string;
  freshness: { status: "fresh" | "stale" | "missing"; ageMilliseconds: number | null; staleAfterMilliseconds: number | null };
  domains: MetricDomains;
  processes: Array<{ targetKind: string; targetId: string; cpuPercent: DashboardMetric; unifiedMemoryBytes: DashboardMetric; cgroupMemoryBytes: DashboardMetric; acceleratorMemoryBytes: DashboardMetric }>;
  workers: Array<{ workerId: string; state: string; profileId: string | null; jobId: string | null; cpuPercent: DashboardMetric; unifiedMemoryBytes: DashboardMetric; acceleratorUtilizationPercent: DashboardMetric }>;
  models: Array<{ profileId: string; state: string; workerId: string | null; unifiedMemoryBytes: DashboardMetric; loadMilliseconds: DashboardMetric }>;
  jobs: Readonly<Record<string, DashboardMetric>>;
  queues: Array<{ nodeId?: string; queueKey: string; depth: DashboardMetric; oldestWaitMilliseconds: DashboardMetric; reasons: Array<{ reasonCode: string; count: number }> }>;
  reservations: Readonly<Record<string, DashboardMetric>>;
  coreServices: Array<{ serviceKey: string; state: string; availabilityPercent: DashboardMetric; latencyMilliseconds: DashboardMetric; errorRatePercent: DashboardMetric }>;
}>;
export type OperationsDashboard = Readonly<{
  generatedAt: string;
  appliance: { deviceId: string; displayName: string; state: string; collectionStatus: "fresh" | "partial" | "stale" | "unavailable"; metrics: DeviceMetricView | null };
  externalProviders: { status: "available" | "unavailable"; reasonCode: string | null; data: Array<{ providerId: string; providerKey: string; displayName: string; lifecycleState: string; freshness: { status: "fresh" | "stale" | "missing"; observedAt: string | null; ageMilliseconds: number | null; staleAfterMilliseconds: number }; health: { state: string; errorCode: string | null; latencyMilliseconds: DashboardMetric }; metrics: Readonly<Record<string, DashboardMetric>>; modelMappings: Array<{ modelProfileId: string; operations: string[]; contextWindow: number; enabled: boolean }> }> };
  alerts: Array<{ alertId: string; severity: "critical" | "warning" | "info"; code: string; scope: { kind: string; id: string }; titleKey: string; detailKey: string; facts: Readonly<Record<string, unknown>> }>;
}>;
export type OperationalHealth = Readonly<{ healthId: string; correlationId: string; target: { kind: string; key: string }; state: "unknown" | "healthy" | "degraded" | "unavailable"; reasonCode: string | null; observedAt: string; facts: Readonly<Record<string, string | number | boolean | null>>; signalId: string | null }>;
export type OperationalAlert = Readonly<{ alertId: string; alertKey: string; severity: "critical" | "warning" | "info"; status: "open" | "resolved"; target: { kind: string; key: string }; correlationId: string; titleKey: string; detailKey: string; facts: Readonly<Record<string, string | number | boolean | null>>; signalIds: string[]; jobIds: string[]; occurrenceCount: number; openedAt: string; lastSeenAt: string; resolvedAt: string | null }>;
export type DiagnosticSignal = Readonly<{ signalId: string; kind: "log" | "metric" | "trace"; correlationId: string; producer: { kind: string; key: string }; eventKey: string; severity: string; observedAt: string; data: Readonly<Record<string, unknown>>; facts: Readonly<Record<string, string | number | boolean | null>>; jobIds: string[]; attemptIds: string[] }>;
export type CorrelationLookup = Readonly<{ correlationId: string; signals: DiagnosticSignal[]; health: OperationalHealth[]; alerts: OperationalAlert[] }>;
export type DiagnosticBundle = Readonly<{ schemaVersion: 1; exportId: string; generatedAt: string; filters: Readonly<Record<string, unknown>>; sensitiveContentIncluded: boolean; signals: DiagnosticSignal[]; health: OperationalHealth[]; alerts: OperationalAlert[]; sensitiveContent: unknown[]; bundleDigest: string; expiresAt: string }>;

export class ApplianceApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = "ApplianceApiError"; }
}

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new ApplianceApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(matches[0].slice("__Host-teamaibox-csrf=".length));
}

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { throw new ApplianceApiError("invalid_response", "Appliance service returned an invalid response", 502); }
  if (!response.ok) throw new ApplianceApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Appliance request failed", response.status);
  return value;
}

export async function loadApplianceDashboard(): Promise<OperationsDashboard> { return request("/api/v1/admin/appliance") as Promise<OperationsDashboard>; }
export async function loadOperationalDiagnostics() {
  const [health, alerts] = await Promise.all([request("/api/v1/admin/operations/health"), loadDiagnosticPages(request, "/api/v1/admin/operations/alerts", ["data"])]);
  return { health: (health.data ?? []) as OperationalHealth[], alerts: (alerts.data ?? []) as OperationalAlert[] };
}
export async function lookupOperationalCorrelation(correlationId: string): Promise<CorrelationLookup> { return loadDiagnosticPages(request, `/api/v1/admin/operations/correlations/${encodeURIComponent(correlationId)}`, ["signals", "health", "alerts"]) as Promise<CorrelationLookup>; }
export async function exportOperationalDiagnostics(input: { correlationId?: string; includeSensitive?: boolean; reason?: string }): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch("/api/v1/admin/operations/diagnostic-exports", { method: "POST", credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken() }, body: JSON.stringify(input) });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new ApplianceApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Diagnostic export failed", response.status);
  }
  // Keep bytes in a Blob; do not inflate all records into JS objects and then
  // serialize the entire history a second time just to download the file.
  const blob = await response.blob();
  const filename = /filename="(teamaibox-diagnostics-[a-f0-9-]+\.json)"/i.exec(response.headers.get("content-disposition") ?? "")?.[1]
    ?? "teamaibox-diagnostics.json";
  return { blob, filename };
}
export async function runOperationalRetention(): Promise<{ completedAt: string; deleted: Readonly<Record<string, number>> }> { return request("/api/v1/admin/operations/retention/run", "POST", {}) as Promise<{ completedAt: string; deleted: Readonly<Record<string, number>> }>; }

