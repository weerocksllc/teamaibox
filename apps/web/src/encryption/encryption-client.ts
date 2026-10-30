export type EncryptionMode = "automatic" | "web_passphrase";
export type EncryptionTransition = Readonly<{
  planId: string; mode: "web_passphrase" | "retired"; state: "prepared" | "committing" | "enabled" | "rolled_back" | "manual_recovery_required";
  revision: number; preparedAt: string; expiresAt: string; enabledAt: string | null; rollbackPassed: boolean | null; failureCode: string | null;
}>;
export type EncryptionAdministration = Readonly<{
  schemaVersion: 1; generatedAt: string;
  blockEncryption: Readonly<{ configured: boolean; mode: "luks2" | "unverified"; status: "verified" | "unverified" | "unavailable" }>;
  startupProtection: Readonly<{ enabled: boolean; mode: EncryptionMode | "retired" }>;
  capabilities: Readonly<{ transition: boolean; webPassphrase: boolean; webPassphraseReason?: string | null }>;
  prerequisites: ReadonlyArray<Readonly<{ key: string; state: "passed" | "failed" | "unavailable" | "pending"; evidenceDigest?: string | null; reason?: string | null }>>;
  latestTransition: EncryptionTransition | null; recentTransitions: ReadonlyArray<EncryptionTransition>;
}>;

export class EncryptionApiError extends Error { constructor(public code: string, message: string, public status: number) { super(message); this.name = "EncryptionApiError"; } }
function csrfToken() {
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new EncryptionApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { throw new EncryptionApiError("invalid_response", "Encryption service returned an invalid response", 502); }
  if (!response.ok) throw new EncryptionApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Encryption request failed", response.status);
  return value;
}
export async function loadEncryptionAdministration(): Promise<EncryptionAdministration> {
  return request("/api/v1/admin/encryption/status") as Promise<EncryptionAdministration>;
}
export async function prepareStartupProtection(input: { mode: Exclude<EncryptionMode, "automatic">; recoveryVerificationId: string; selectedVerificationId: string; confirmation: string }): Promise<EncryptionTransition> {
  return request("/api/v1/admin/encryption/protection/enable", "POST", { phase: "prepare", mode: input.mode,
    recovery_verification_id: input.recoveryVerificationId, selected_verification_id: input.selectedVerificationId,
    request_id: crypto.randomUUID(), confirmation: input.confirmation }) as Promise<EncryptionTransition>;
}
export async function commitStartupProtection(plan: EncryptionTransition, confirmation: string): Promise<EncryptionTransition> {
  return request("/api/v1/admin/encryption/protection/enable", "POST", { phase: "commit", plan_id: plan.planId,
    expected_revision: plan.revision, confirmation }) as Promise<EncryptionTransition>;
}
