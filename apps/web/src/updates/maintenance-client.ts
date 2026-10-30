export type MaintenanceKind = "platform" | "host";
export type MaintenanceCandidate = Readonly<{ candidateKey: string; displayName: string; kind: MaintenanceKind; version: string; digest: string; requiresReboot: boolean; rollbackAvailable: boolean }>;
export type MaintenanceNode = Readonly<{ nodeId: string; nodeKey: string; lifecycleState: "ready" | "draining" | "offline" | "disabled" | "joining"; healthState: "healthy" | "degraded" | "offline" | "unknown" }>;
export type MaintenancePlan = Readonly<{ planId: string; kind: MaintenanceKind; candidate: MaintenanceCandidate; targetNodes: MaintenanceNode[]; strategy: "single_node_downtime";
  state: "blocked" | "ready" | "executing" | "completed" | "rolled_back" | "manual_recovery_required"; blockers: string[]; warnings: string[];
  preflight: { evidenceDigest: string; passed: boolean; blockers: string[]; warnings: string[]; secureBootCompatible: boolean; runtimeCompatible: boolean };
  compatibility: { evidenceDigest: string; incompatibleProfileIds: string[]; requiresRevalidationProfileIds: string[] }; revalidationDecision: "fence_and_revalidate" | null;
  recoveryInstructions: string[]; rollbackInstructions: string[]; currentNodeId: string | null; completedNodeIds: string[];
  nodeEvidence: Array<{ nodeId: string; drainDigest: string; applyDigest: string; postCheckDigest: string }>;
  postCheck: null | { evidenceDigest: string; passed: boolean }; failureCode: string | null; revision: number; requestedBy: string; createdAt: string; updatedAt: string; completedAt: string | null }>;
export type MaintenanceAdministration = Readonly<{ generatedAt: string; candidates: MaintenanceCandidate[]; nodes: MaintenanceNode[]; plans: MaintenancePlan[] }>;

export class MaintenanceApiError extends Error { constructor(public code: string, message: string, public status: number) { super(message); this.name = "MaintenanceApiError"; } }
function csrfToken() { const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf=")); if (values.length !== 1) throw new MaintenanceApiError("csrf_unavailable", "Session verification is unavailable", 401); return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length)); }
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { throw new MaintenanceApiError("invalid_response", "Maintenance service returned an invalid response", 502); }
  if (!response.ok) throw new MaintenanceApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Maintenance request failed", response.status); return value;
}
export async function loadMaintenanceAdministration(): Promise<MaintenanceAdministration> { return request("/api/v1/admin/updates") as Promise<MaintenanceAdministration>; }
export async function prepareMaintenancePlan(input: { kind: MaintenanceKind; candidateKey: string; deviceId: string; downtimeAcknowledged: boolean; revalidationDecision: "fence_and_revalidate" | null }): Promise<MaintenancePlan> {
  return request("/api/v1/admin/updates/plans", "POST", { kind: input.kind, candidate_key: input.candidateKey, target_node_ids: [input.deviceId], strategy: "single_node_downtime",
    downtime_acknowledged: input.downtimeAcknowledged, revalidation_decision: input.revalidationDecision, operation_key: `maintenance:${crypto.randomUUID()}` }) as Promise<MaintenancePlan>;
}
export async function executeMaintenancePlan(planId: string, expectedRevision: number, confirmation: string): Promise<MaintenancePlan> {
  return request(`/api/v1/admin/updates/plans/${encodeURIComponent(planId)}/execute`, "POST", { expected_revision: expectedRevision, confirmation }) as Promise<MaintenancePlan>;
}
