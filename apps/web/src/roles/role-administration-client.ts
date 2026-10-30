export type AuthorizationRole = Readonly<{
  roleKey: string;
  displayNameKey: string;
  descriptionKey: string;
  systemRole: boolean;
  allowedScopes: ReadonlyArray<string>;
  permissions: ReadonlyArray<string>;
  bindingCount: number;
}>;

export type RoleIdentity = Readonly<{
  id: string;
  loginName: string;
  displayName: string;
  status: "active" | "disabled";
  roles: ReadonlyArray<string>;
}>;

export type RoleAdministrationOverview = Readonly<{
  roles: ReadonlyArray<AuthorizationRole>;
  identities: ReadonlyArray<RoleIdentity>;
  identityPage: DirectoryPage;
}>;

export class RoleAdministrationApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new RoleAdministrationApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(matches[0].slice("__Host-teamaibox-csrf=".length));
}

async function accepted(response: Response) {
  const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new RoleAdministrationApiError(value?.error?.code ?? "role_request_failed", value?.error?.message ?? "Role request failed", response.status);
  return value;
}

export async function loadRoleAdministration(offset = 0, query = ""): Promise<RoleAdministrationOverview> {
  const params = new URLSearchParams({ limit: "50", offset: String(offset), q: query });
  return accepted(await fetch(`/api/v1/admin/roles?${params}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } })) as Promise<RoleAdministrationOverview>;
}

export async function setIdentityRole(input: { identityId: string; roleKey: string; granted: boolean }) {
  return accepted(await fetch(`/api/v1/admin/roles/${encodeURIComponent(input.roleKey)}/grants`, {
    method: "POST", credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken() },
    body: JSON.stringify({ identityId: input.identityId, granted: input.granted }),
  }));
}
import type { DirectoryPage } from "../users/DirectoryControls";
