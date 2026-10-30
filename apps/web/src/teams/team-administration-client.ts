export type TeamIdentity = Readonly<{ id: string; loginName: string; displayName: string; status: "active" | "disabled" }>;
export type TeamMember = Readonly<{ identity: TeamIdentity; roleKey: "team_admin" | "member" | "guest" }>;
export type TeamRecord = Readonly<{ id: string; teamKey: string; displayName: string; status: "active" | "archived"; systemTeam: boolean; memberCount: number; members: ReadonlyArray<TeamMember>; updatedAt: string | null }>;
export type TeamOverview = Readonly<{ teams: ReadonlyArray<TeamRecord>; identities: ReadonlyArray<TeamIdentity>; identityPage: DirectoryPage; membershipRoles: ReadonlyArray<"team_admin" | "member" | "guest"> }>;

export class TeamAdministrationApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new TeamAdministrationApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(matches[0].slice("__Host-teamaibox-csrf=".length));
}

async function accepted(response: Response) {
  const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new TeamAdministrationApiError(value?.error?.code ?? "team_request_failed", value?.error?.message ?? "Team request failed", response.status);
  return value;
}

export async function loadTeamAdministration(offset = 0, query = ""): Promise<TeamOverview> {
  const params = new URLSearchParams({ limit: "50", offset: String(offset), q: query });
  return accepted(await fetch(`/api/v1/admin/teams?${params}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } })) as Promise<TeamOverview>;
}

export async function setTeamMembership(input: { teamId: string; identityId: string; roleKey: string; granted: boolean }) {
  return accepted(await fetch(`/api/v1/admin/teams/${encodeURIComponent(input.teamId)}/members`, {
    method: "POST", credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken() },
    body: JSON.stringify({ identityId: input.identityId, roleKey: input.roleKey, granted: input.granted }),
  }));
}
import type { DirectoryPage } from "../users/DirectoryControls";
