export type AuditDomain = "identity" | "data" | "plugin" | "model" | "provider" | "routing" | "agent_confirmation" | "source" | "security" | "key" | "backup" | "update" | "administrator";
export type AuditEvent = Readonly<{
  sequenceId: number; schemaVersion: 1; eventId: string; occurredAt: string;
  actor: { identityId: string | null; kind: "user" | "administrator" | "service" | "system" };
  action: string; domain: AuditDomain; outcome: "succeeded" | "failed" | "denied";
  resource: { kind: string; id: string }; correlationId: string;
  metadata: Readonly<Record<string, string | number | boolean | null | Array<string | number | boolean | null>>>;
  previousEventHash: string | null; eventHash: string;
  checkpoint: { algorithm: "hmac-sha256"; keyId: string; signature: string };
}>;
export type AuditEventPage = Readonly<{ object: "list"; data: AuditEvent[]; hasMore: boolean; nextCursor: string | null }>;
export type AuditVerification = Readonly<{ valid: boolean; verifiedEvents: number; failedSequenceId: number | null; reasonCode: string | null; headEventHash: string | null; verifiedAt: string }>;

export class AuditApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = "AuditApiError"; }
}

async function getJson(path: string) {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  let value: any; try { value = await response.json(); } catch { throw new AuditApiError("invalid_response", "Audit service returned an invalid response", 502); }
  if (!response.ok) throw new AuditApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Audit request failed", response.status);
  return value;
}

export async function loadAuditEvents({ domain = null, correlationId = null, cursor = null, limit = 100 }: { domain?: AuditDomain | null; correlationId?: string | null; cursor?: string | null; limit?: number } = {}): Promise<AuditEventPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (domain) query.set("domain", domain); if (correlationId) query.set("correlationId", correlationId); if (cursor) query.set("cursor", cursor);
  return getJson(`/api/v1/admin/audit/events?${query}`) as Promise<AuditEventPage>;
}
export async function verifyAuditChain(): Promise<AuditVerification> { return getJson("/api/v1/admin/audit/verify") as Promise<AuditVerification>; }
