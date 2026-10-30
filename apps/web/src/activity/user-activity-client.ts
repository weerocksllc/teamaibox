export type UserServiceAvailability = Readonly<{
  applicationKey: string;
  capabilityKey: string;
  state: "available" | "busy" | "degraded" | "unavailable" | "unknown";
  reasonKey: string;
  wait: { estimateStatus: "estimated" | "unavailable"; estimatedSeconds: number | null; basis: "no_queue" | "queue_age_proxy" | null };
  observedAt: string | null;
}>;

export type UserTask = Readonly<{
  taskId: string;
  taskKind: string;
  titleKey: string;
  state: "queued" | "preparing" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  progressRevision: number;
  cancellationRequested: boolean;
  wait: { reasonKey: string | null; estimateStatus: "estimated" | "unavailable" | "not_applicable"; estimatedSeconds: number | null };
  failure: null | { code: string; guidanceKey: string; retryable: boolean; retryAction: string | null };
  results: ReadonlyArray<{ label: string; artifactRef: string }>;
  canCancel: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  terminalAt: string | null;
}>;

export type UserActivityOverview = Readonly<{
  generatedAt: string;
  availability: ReadonlyArray<UserServiceAvailability>;
  tasks: ReadonlyArray<UserTask>;
  summary: { total: number; active: number; waiting: number; failed: number };
}>;

export class UserActivityApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = "UserActivityApiError"; }
}

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new UserActivityApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(matches[0].slice("__Host-teamaibox-csrf=".length));
}

async function accepted(response: Response) {
  let value: any;
  try { value = await response.json(); } catch { throw new UserActivityApiError("invalid_response", "Task service returned an invalid response", 502); }
  if (!response.ok) throw new UserActivityApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Task request failed", response.status);
  return value;
}

export async function loadUserActivity({ signal }: { signal?: AbortSignal } = {}): Promise<UserActivityOverview> {
  return accepted(await fetch("/api/v1/user/activity", { signal, credentials: "same-origin", headers: { accept: "application/json" } }));
}

export async function cancelUserTask(taskId: string): Promise<UserTask> {
  return accepted(await fetch(`/api/v1/user/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken() }, body: "{}",
  }));
}
