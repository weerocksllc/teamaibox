import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function limit(query) {
  const raw = query?.get?.("limit") ?? "20";
  if (!/^[1-9][0-9]?$/.test(raw)) throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
  const value = Number(raw);
  if (value > 50) throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
  return value;
}

export function matchesIdentityDirectoryHttpRoute(method, pathname) {
  return method === "GET" && new Set([
    "/api/v1/session/bootstrap", "/api/v1/identities", "/api/v1/identities/directory", "/api/v1/identities/search",
  ]).has(pathname);
}

export class IdentityDirectoryHttpApi {
  #service;
  constructor({ service }) {
    if (!service?.byIds || !service?.list || !service?.search) throw new TypeError("Identity directory service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesIdentityDirectoryHttpRoute(method, pathname); }
  async handle({ method, pathname, context, query = new URLSearchParams() }) {
    if (!matchesIdentityDirectoryHttpRoute(method, pathname)) throw new PlatformError("not_found", "Identity directory endpoint was not found", { status: 404 });
    if (pathname === "/api/v1/session/bootstrap") {
      return { kind: "json", status: 200, body: {
        actor: { identityId: context.identityId, displayName: context.identity.displayName },
        permissions: context.permissions,
      } };
    }
    if (pathname === "/api/v1/identities") {
      const data = await this.#service.byIds({ context, identityIds: (query.get("ids") || "").split(",").filter(Boolean) });
      return { kind: "json", status: 200, body: { object: "list", data, meta: { actorIdentityId: context.identityId } } };
    }
    if (pathname === "/api/v1/identities/directory") {
      const raw = query.get("after") ?? "0", after = Number(raw), pageSize = limit(query);
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(after)) throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
      const data = await this.#service.list({ context, limit: pageSize, after });
      return { kind: "json", status: 200, body: { object: "list", data, meta: { actorIdentityId: context.identityId, nextOffset: data.length === pageSize ? after + data.length : null } } };
    }
    const data = await this.#service.search({ context, query: query.get("q"), limit: limit(query) });
    return { kind: "json", status: 200, body: { object: "list", data } };
  }
}
