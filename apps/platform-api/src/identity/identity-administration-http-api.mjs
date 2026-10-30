import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const COLLECTION = "/api/v1/admin/users";
const ACTION = /^\/api\/v1\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(disable|enable|reset-password)$/i;
const ROLE_COLLECTION = "/api/v1/admin/roles";
const ROLE_ACTION = /^\/api\/v1\/admin\/roles\/([a-z][a-z0-9._-]{2,63})\/grants$/;
const TEAM_COLLECTION = "/api/v1/admin/teams";
const TEAM_MEMBERSHIP = /^\/api\/v1\/admin\/teams\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/members$/i;

function limit(query) {
  const raw = query?.get?.("limit") ?? "200";
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 200) {
    throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
  }
  return Number(raw);
}

function directoryQuery(query) {
  const raw = query.get("offset") ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
  }
  return { limit: limit(query), offset: Number(raw), query: query.get("q") ?? "" };
}

export function matchesIdentityAdministrationHttpRoute(method, pathname) {
  if (pathname === COLLECTION) return method === "GET" || method === "POST";
  if (pathname === ROLE_COLLECTION) return method === "GET";
  if (ROLE_ACTION.test(pathname)) return method === "POST";
  if (pathname === TEAM_COLLECTION) return method === "GET";
  if (TEAM_MEMBERSHIP.test(pathname)) return method === "POST";
  return method === "POST" && ACTION.test(pathname);
}

export class IdentityAdministrationHttpApi {
  #service;

  constructor({ service }) {
    if (!service || ["list", "createLocalMember", "setStatus", "resetPassword", "listRoles", "setRole", "listTeams", "setTeamMembership"].some((method) => typeof service[method] !== "function")) {
      throw new TypeError("Identity administration service is incomplete");
    }
    this.#service = service;
  }

  matches(method, pathname) {
    return matchesIdentityAdministrationHttpRoute(method, pathname);
  }

  async handle({ method, pathname, context, body = null, query = new URLSearchParams() }) {
    if (method === "GET" && pathname === TEAM_COLLECTION) {
      const value = await this.#service.listTeams({ context, ...directoryQuery(query) });
      return { kind: "json", status: 200, body: value };
    }
    const membershipMatch = TEAM_MEMBERSHIP.exec(pathname);
    if (method === "POST" && membershipMatch) {
      const value = await this.#service.setTeamMembership({
        context, teamId: membershipMatch[1], identityId: body?.identityId,
        roleKey: body?.roleKey, granted: body?.granted,
      });
      return { kind: "json", status: 200, body: value };
    }
    if (method === "GET" && pathname === ROLE_COLLECTION) {
      const value = await this.#service.listRoles({ context, ...directoryQuery(query) });
      return { kind: "json", status: 200, body: value };
    }
    const roleMatch = ROLE_ACTION.exec(pathname);
    if (method === "POST" && roleMatch) {
      const value = await this.#service.setRole({ context, roleKey: roleMatch[1], identityId: body?.identityId, granted: body?.granted });
      return { kind: "json", status: 200, body: value };
    }
    if (method === "GET" && pathname === COLLECTION) {
      const value = await this.#service.listPage({ context, ...directoryQuery(query) });
      return { kind: "json", status: 200, body: value };
    }
    if (method === "POST" && pathname === COLLECTION) {
      const identity = await this.#service.createLocalMember({
        context,
        loginName: body?.loginName,
        displayName: body?.displayName,
        password: body?.password,
      });
      return { kind: "json", status: 201, body: identity };
    }
    const match = ACTION.exec(pathname);
    if (method === "POST" && match) {
      const [, identityId, action] = match;
      const identity = action === "reset-password"
        ? await this.#service.resetPassword({ context, identityId, password: body?.password })
        : await this.#service.setStatus({
          context,
          identityId,
          status: action === "disable" ? "disabled" : "active",
        });
      return { kind: "json", status: 200, body: identity };
    }
    throw new PlatformError("not_found", "Identity administration endpoint was not found", { status: 404 });
  }
}
