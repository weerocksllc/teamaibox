export type StorageDataClass = "team-file" | "message-attachment" | "ai-artifact" | "dataset" | "checkpoint" | "model-artifact" | "agent-workspace" | "plugin-data" | "cache";
export type StoragePool = Readonly<{
  poolId: string; displayName: string; backendKind: "local-block" | "local-filesystem" | "s3-compatible"; nodeId: string | null;
  failureDomain: string; lifecycleState: "active" | "draining" | "drained" | "removed"; healthState: "unknown" | "healthy" | "degraded" | "unavailable";
  totalBytes: number | null; availableBytes: number | null; safetyReserveBytes: number; encryptionMode: "none" | "luks2" | "provider-managed";
  encryptionStatus: "pending" | "verified" | "failed"; compatibilityStatus: "pending" | "verified" | "failed"; dataClasses: StorageDataClass[];
  allocationCount: number; allocatedBytes: number; liveReservationCount: number; liveReservationBytes: number; incompleteMigrationCount: number;
  observedAt: string | null; createdAt: string; updatedAt: string; removedAt: string | null;
}>;
export type StorageAdministration = Readonly<{ schemaVersion: 1; generatedAt: string; dataClasses: StorageDataClass[];
  summary: Readonly<{ poolCount: number; activePoolCount: number; degradedPoolCount: number; totalBytes: number; availableBytes: number; allocatedBytes: number }>; pools: StoragePool[] }>;

export class StorageApiError extends Error { constructor(public code: string, message: string, public status: number) { super(message); this.name = "StorageApiError"; } }
function csrfToken() { const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf=")); if (values.length !== 1) throw new StorageApiError("csrf_unavailable", "Session verification is unavailable", 401); return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length)); }
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { throw new StorageApiError("invalid_response", "Storage service returned an invalid response", 502); }
  if (!response.ok) throw new StorageApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Storage request failed", response.status); return value;
}
export async function loadStorageAdministration(): Promise<StorageAdministration> { return request("/api/v1/admin/storage/pools") as Promise<StorageAdministration>; }
export async function registerStoragePool(input: { poolId: string; displayName: string; backendKind: StoragePool["backendKind"]; nodeId: string | null; failureDomain: string;
  totalBytes: number; availableBytes: number; safetyReserveBytes: number; encryptionMode: "luks2" | "provider-managed"; dataClasses: StorageDataClass[]; verificationConfirmation: string }): Promise<StoragePool> {
  return request("/api/v1/admin/storage/pools", "POST", { pool_id: input.poolId, display_name: input.displayName, backend_kind: input.backendKind,
    node_id: input.nodeId, failure_domain: input.failureDomain, total_bytes: input.totalBytes, available_bytes: input.availableBytes,
    safety_reserve_bytes: input.safetyReserveBytes, encryption_mode: input.encryptionMode, data_classes: input.dataClasses,
    verification_confirmation: input.verificationConfirmation }) as Promise<StoragePool>;
}
export async function replaceStorageDataClasses(pool: StoragePool, dataClasses: StorageDataClass[]): Promise<StoragePool> {
  return request(`/api/v1/admin/storage/pools/${encodeURIComponent(pool.poolId)}/data-classes`, "PUT", { expected_updated_at: pool.updatedAt, data_classes: dataClasses }) as Promise<StoragePool>;
}
export async function transitionStoragePool(pool: StoragePool, action: "drain" | "complete" | "remove", confirmation: string): Promise<StoragePool> {
  return request(`/api/v1/admin/storage/pools/${encodeURIComponent(pool.poolId)}/${action}`, "POST", { expected_updated_at: pool.updatedAt, confirmation }) as Promise<StoragePool>;
}
