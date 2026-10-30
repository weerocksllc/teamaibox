import type { ProductLocale } from "../../../../packages/ui-system/src/locale-registry.mjs";
export type ManagedIdentity = Readonly<{
  id: string;
  identityKind: "local_user";
  loginName: string;
  displayName: string;
  status: "active" | "disabled";
  roles: string[];
  preferredLocale: ProductLocale;
  preferredTheme: "light" | "dark" | "system";
  lastAuthenticatedAt: string | null;
  disabledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export class IdentityAdministrationApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "IdentityAdministrationApiError";
    this.code = code;
    this.status = status;
  }
}

function csrfToken() {
  const values = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) {
    throw new IdentityAdministrationApiError("csrf_unavailable", "Session verification is unavailable", 401);
  }
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}

async function request(path: string, method = "GET", body?: object) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        "x-csrf-token": csrfToken(),
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value: any;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAdministrationApiError("invalid_response", "Identity service returned an invalid response", 502);
  }
  if (!response.ok) {
    throw new IdentityAdministrationApiError(
      typeof value?.error?.code === "string" ? value.error.code : "request_failed",
      typeof value?.error?.message === "string" ? value.error.message : "Identity request failed",
      response.status,
    );
  }
  return value;
}

export type IdentityPage = Readonly<{
  data: ManagedIdentity[];
  summary: { total: number; active: number; owners: number; matching: number };
  offset: number;
  limit: number;
  hasMore: boolean;
}>;

export async function listManagedIdentities(offset = 0, query = ""): Promise<IdentityPage> {
  const parameters = new URLSearchParams({ limit: "50", offset: String(offset), q: query });
  const result = await request(`/api/v1/admin/users?${parameters}`);
  if (!Array.isArray(result?.data) || !result?.summary
    || ["total", "active", "owners", "matching"].some((key) => !Number.isSafeInteger(result.summary[key]))) {
    throw new IdentityAdministrationApiError("invalid_response", "Identity listing is incomplete", 502);
  }
  return result;
}

export function createLocalMember(input: { loginName: string; displayName: string; password: string }): Promise<ManagedIdentity> {
  return request("/api/v1/admin/users", "POST", input);
}

export function setManagedIdentityStatus(identityId: string, status: "active" | "disabled"): Promise<ManagedIdentity> {
  const action = status === "active" ? "enable" : "disable";
  return request(`/api/v1/admin/users/${encodeURIComponent(identityId)}/${action}`, "POST", {});
}

export function resetManagedIdentityPassword(identityId: string, password: string): Promise<ManagedIdentity> {
  return request(`/api/v1/admin/users/${encodeURIComponent(identityId)}/reset-password`, "POST", { password });
}
