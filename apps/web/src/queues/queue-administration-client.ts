export type QueuePolicy = Readonly<{
  policyKey: "default"; minimumPriority: number; maximumPriority: number;
  maxQueuedPerOwner: number; maxActivePerOwner: number; maxQueuedPerCapability: number;
  maxDailySubmissionsPerOwner: number; maxRequestBytes: number; maxDeadlineSeconds: number;
  revision: number; updatedBy: string | null; createdAt: string; updatedAt: string;
}>;
export type QueueJob = Readonly<{
  jobId: string; ownerIdentityId: string; capabilityKey: string; operation: string; status: string;
  priority: number; route: string; waitingReason: string | null; attemptCount: number;
  currentAttemptStatus: string | null; cancellationRequested: boolean; canCancel: boolean;
  createdAt: string; updatedAt: string;
}>;
export type QueueAdministration = Readonly<{
  schemaVersion: 1; generatedAt: string; policy: QueuePolicy;
  summary: { totalJobs: number; activeJobs: number; activeLeases: number; realtimeReservations: number; exclusiveIntents: number; oldestQueuedAt: string | null };
  statusCounts: Array<{ status: string; count: number }>;
  waitingReasons: Array<{ reasonCode: string; count: number }>;
  priorityBands: Array<{ band: "urgent" | "normal" | "background"; count: number }>;
  jobs: QueueJob[];
  realtimeReservations: Array<{ reservationId: string; ownerIdentityId: string; capabilityKey: string; state: string; priorityClass: string; schedulerPriority: number; latencyBudgetMilliseconds: number; nodeId: string; route: string; admittedAt: string; expiresAt: string }>;
  exclusiveIntents: Array<{ intentId: string; jobId: string; nodeId: string; capabilityKey: string; state: string; requestedAt: string; deadlineAt: string }>;
}>;
export type QueuePolicyInput = Omit<QueuePolicy, "policyKey" | "revision" | "updatedBy" | "createdAt" | "updatedAt">;

export class QueueAdministrationApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = "QueueAdministrationApiError"; }
}
function csrfToken() {
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new QueueAdministrationApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { throw new QueueAdministrationApiError("invalid_response", "Queue service returned an invalid response", 502); }
  if (!response.ok) throw new QueueAdministrationApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Queue request failed", response.status);
  return value;
}
export async function loadQueueAdministration(): Promise<QueueAdministration> { return request("/api/v1/admin/queues?limit=100") as Promise<QueueAdministration>; }
export async function updateQueuePolicy(expectedRevision: number, policy: QueuePolicyInput): Promise<QueuePolicy> {
  return request("/api/v1/admin/queues/policy", "PUT", { expectedRevision, policy }) as Promise<QueuePolicy>;
}
export async function cancelQueueJob(jobId: string): Promise<{ jobId: string; status: string; cancellationRequested: boolean; terminalAt: string | null; updatedAt: string }> {
  return request(`/api/v1/admin/jobs/${encodeURIComponent(jobId)}/cancel`, "POST", { confirmation: `CANCEL ${jobId}` }) as Promise<any>;
}
