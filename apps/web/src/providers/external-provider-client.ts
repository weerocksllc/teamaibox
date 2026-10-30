export type ExternalProvider = Readonly<{
  providerId: string;
  providerKey: string;
  displayName: string;
  endpoint: string;
  lifecycleState: "disabled" | "healthy" | "degraded" | "unavailable";
  auth: { scheme: "none" | "bearer" | "api_key_header"; headerName: string | null; credentialConfigured: boolean };
  trust: { mode: "system_ca" | "custom_ca"; serverName: string | null; customCaConfigured: boolean };
  allowedDataClasses: string[];
  limits: { concurrency: number; requestsPerMinute: number; tokensPerMinute: number | null };
  timeouts: { connectMilliseconds: number; requestMilliseconds: number; idleStreamMilliseconds: number };
  health: { state: "unknown" | "healthy" | "degraded" | "unavailable"; latencyMilliseconds: number | null; errorCode: string | null; observedAt: string | null; consecutiveFailures: number };
  contract: { state: "untested" | "passed" | "failed"; evidenceDigest: string | null; testedAt: string | null; failedChecks: string[] };
  costAccounting: { currency: string; accountingMode: string };
  modelMappings: Array<{ modelProfileId: string; providerModelName: string; operations: string[]; contextWindow: number; maximumOutputTokens: number | null; routingWeight: number; enabled: boolean }>;
  revision: number;
  updatedAt: string;
}>;

export type RoutingPolicy = Readonly<{
  policyId: string;
  policyKey: string;
  displayName: string;
  selector: { capabilityId: string | null; operation: string | null; teamId: string | null; dataClasses: string[] };
  priority: number;
  routing: {
    mode: "internal_only" | "internal_first" | "external_first" | "weighted" | "pinned";
    externalProcessingApproved: boolean;
    pinnedTargetId: string | null;
    pinnedProfileId: string | null;
    targetWeights: Record<string, number>;
  };
  enabled: boolean;
  revision: number;
}>;

export class ExternalProviderApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ExternalProviderApiError";
  }
}

async function accepted(response: Response) {
  let value: any;
  try { value = await response.json(); } catch { throw new ExternalProviderApiError("invalid_response", "External compute returned an invalid response", 502); }
  if (!response.ok) throw new ExternalProviderApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "External compute request failed", response.status);
  return value;
}

function csrfToken() {
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new ExternalProviderApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}

async function request(path: string, method = "GET", body?: unknown) {
  return accepted(await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

export async function listExternalProviders(): Promise<ExternalProvider[]> {
  const value = await request("/api/v1/admin/providers");
  return (value.data ?? []) as ExternalProvider[];
}

export async function createExternalProvider(declaration: Record<string, unknown>): Promise<ExternalProvider> {
  return request("/api/v1/admin/providers", "POST", declaration);
}

export async function testExternalProvider(provider: ExternalProvider): Promise<ExternalProvider> {
  return request(`/api/v1/admin/providers/${provider.providerId}/test`, "POST", { expectedRevision: provider.revision });
}

export async function setExternalProviderEnabled(provider: ExternalProvider, enabled: boolean): Promise<ExternalProvider> {
  return request(`/api/v1/admin/providers/${provider.providerId}/${enabled ? "enable" : "disable"}`, "POST", { expectedRevision: provider.revision });
}

export async function rotateExternalProviderCredential(provider: ExternalProvider, credential: string): Promise<{ activeVersion: number; rotatedAt: string }> {
  return request(`/api/v1/admin/providers/${provider.providerId}/credential/rotate`, "POST", { credential });
}

export async function removeExternalProvider(provider: ExternalProvider): Promise<{ providerId: string; providerKey: string; removedAt: string }> {
  return request(`/api/v1/admin/providers/${provider.providerId}`, "DELETE", { expectedRevision: provider.revision });
}

export async function listRoutingPolicies(): Promise<RoutingPolicy[]> {
  const value = await request("/api/v1/admin/routing-policies");
  return (value.data ?? []) as RoutingPolicy[];
}

export async function createRoutingPolicy(declaration: Record<string, unknown>): Promise<RoutingPolicy> {
  return request("/api/v1/admin/routing-policies", "POST", declaration);
}

export async function updateRoutingPolicy(policy: RoutingPolicy, declaration: Record<string, unknown>): Promise<RoutingPolicy> {
  return request(`/api/v1/admin/routing-policies/${policy.policyId}`, "PATCH", { expectedRevision: policy.revision, declaration });
}
