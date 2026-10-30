import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const EVENTS = /^\/api\/v1\/admin\/audit\/events$/;
const VERIFY = /^\/api\/v1\/admin\/audit\/verify$/;

export function matchesAuditHttpRoute(method, pathname) { return method === "GET" && (EVENTS.test(pathname) || VERIFY.test(pathname)); }

export class AuditHttpApi {
  #service;
  constructor({ service }) {
    if (!service || typeof service.listEvents !== "function" || typeof service.verifyChain !== "function") throw new TypeError("audit service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesAuditHttpRoute(method, pathname); }
  async handle({ method, pathname, context, query = null }) {
    if (method === "GET" && EVENTS.test(pathname)) return { kind: "json", status: 200, body: await this.#service.listEvents({ context,
      domain: query?.get?.("domain") || null, correlationId: query?.get?.("correlationId") || null,
      cursor: query?.get?.("cursor") || null, limit: query?.get?.("limit") || 100 }) };
    if (method === "GET" && VERIFY.test(pathname)) return { kind: "json", status: 200, body: await this.#service.verifyChain({ context }) };
    throw new PlatformError("not_found", "Audit endpoint was not found", { status: 404 });
  }
}
