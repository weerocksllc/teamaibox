export type AssistantMode = "auto" | "answer" | "agent";
export type EffectiveAssistantMode = "answer" | "agent";

export type AssistantRouting = Readonly<{
  effectiveMode: EffectiveAssistantMode;
  targetKind: "internal" | "external";
  providerKey: string;
  modelKey: string;
  profileKey: string | null;
  reasonKey: string;
}>;

export type AssistantArtifact = Readonly<{
  referenceId: string;
  label: string;
  mimeType: string;
  sizeBytes: number;
  downloadPath: string | null;
}>;

export type AssistantSource = Readonly<{
  referenceId: string;
  label: string;
  url: string | null;
}>;

export type AssistantToolCall = Readonly<{
  id: string;
  name: string;
  summary: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
}>;

export type AssistantUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  costMicrounits: number;
  currency: string;
}>;

export type AssistantMessage = Readonly<{
  id: string;
  conversationId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  requestedMode: AssistantMode;
  effectiveMode: EffectiveAssistantMode;
  status: "streaming" | "completed" | "failed" | "cancelled";
  artifacts: AssistantArtifact[];
  sources: AssistantSource[];
  toolCalls: AssistantToolCall[];
  routing: AssistantRouting | null;
  usage: AssistantUsage | null;
  error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
  createdAt: string;
  completedAt: string | null;
}>;

export type AssistantConfirmation = Readonly<{
  kind: "agent_operation_confirmation";
  id: string;
  ownerIdentityId: string;
  agentSessionKey: string;
  operationKind: string;
  titleKey: string;
  scope: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: string;
  decidedAt: string | null;
}>;

export type AssistantConversationSummary = Readonly<{
  id: string;
  object: "assistant.conversation";
  title: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AssistantConversation = AssistantConversationSummary & Readonly<{
  messages: AssistantMessage[];
  confirmations: AssistantConfirmation[];
  eventCursor: number;
}>;

export type AssistantEvent = Readonly<{
  id: string;
  sequence: number;
  conversationId: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}>;

export class AssistantApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AssistantApiError";
    this.code = code;
    this.status = status;
  }
}

async function acceptedJson(response: Response) {
  let value: any;
  try {
    value = await response.json();
  } catch {
    throw new AssistantApiError("invalid_response", "Assistant service returned an invalid response", 502);
  }
  if (!response.ok) {
    throw new AssistantApiError(
      typeof value?.error?.code === "string" ? value.error.code : "request_failed",
      typeof value?.error?.message === "string" ? value.error.message : "Assistant request failed",
      response.status,
    );
  }
  return value;
}

function csrfToken() {
  const matches = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new AssistantApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return matches[0].slice(matches[0].indexOf("=") + 1);
}

async function jsonRequest(path: string, init: RequestInit = {}) {
  return acceptedJson(await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...init.headers },
    ...init,
  }));
}

async function mutation(path: string, body: object, headers: Record<string, string> = {}) {
  return jsonRequest(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export async function listAssistantConversations(): Promise<AssistantConversationSummary[]> {
  return (await jsonRequest("/api/v1/assistant/conversations")).data;
}

export async function createAssistantConversation(title: string | null = null): Promise<AssistantConversationSummary> {
  return mutation("/api/v1/assistant/conversations", { title });
}

export async function getAssistantConversation(conversationId: string): Promise<AssistantConversation> {
  return jsonRequest(`/api/v1/assistant/conversations/${conversationId}`);
}

export async function submitAssistantMessage(conversationId: string, input: string, mode: AssistantMode, inputReferenceIds: string[] = []) {
  return mutation(
    `/api/v1/assistant/conversations/${conversationId}/messages`,
    { input, mode, input_reference_ids: inputReferenceIds },
    { "idempotency-key": `browser-${crypto.randomUUID()}` },
  );
}

export async function uploadAssistantInput(file: File): Promise<{ referenceId: string; expiresAt: string }> {
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const response = await acceptedJson(await fetch("/api/v1/objects/uploads?capability=assistant.input", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-content-sha256": digest,
      "x-csrf-token": csrfToken(),
      "x-teamaibox-object-name": encodeURIComponent(file.name),
    },
    body: file,
  }));
  return { referenceId: response.reference_id, expiresAt: response.reference_expires_at };
}

export async function cancelAssistantRun(runId: string) {
  return mutation(`/api/v1/assistant/runs/${runId}/cancel`, {});
}

export async function decideAssistantConfirmation(confirmationId: string, decision: "approved" | "denied") {
  return mutation(`/api/v1/assistant/confirmations/${confirmationId}/decision`, { decision });
}

const assistantEventTypes = [
  "message.created", "message.completed", "run.created", "run.started", "run.completed",
  "run.failed", "run.cancelled", "routing.selected", "response.delta", "tool.started",
  "tool.completed", "artifact.created", "source.cited", "usage.updated",
  "confirmation.requested", "confirmation.resolved",
] as const;

export function subscribeAssistantEvents({
  conversationId,
  afterSequence,
  onEvent,
  onConnection,
}: {
  conversationId: string;
  afterSequence: number;
  onEvent: (event: AssistantEvent) => void;
  onConnection: (state: "connected" | "reconnecting") => void;
}) {
  const source = new EventSource(
    `/api/v1/assistant/conversations/${conversationId}/events?after=${afterSequence}`,
    { withCredentials: true },
  );
  let cursor = afterSequence;
  source.onopen = () => onConnection("connected");
  source.onerror = () => onConnection("reconnecting");
  const listener = (raw: Event) => {
    try {
      const value = JSON.parse((raw as MessageEvent).data) as AssistantEvent;
      if (value.sequence <= cursor) return;
      cursor = value.sequence;
      onEvent(value);
    } catch {
      onConnection("reconnecting");
    }
  };
  for (const type of assistantEventTypes) source.addEventListener(type, listener);
  return () => source.close();
}
