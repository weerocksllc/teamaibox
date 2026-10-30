import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const POLICIES = /^\/api\/v1\/admin\/routing-policies$/;
const POLICY = new RegExp(`^/api/v1/admin/routing-policies/${UUID}$`, "i");

export class RoutingPolicyHttpApi {
  #service;
  constructor({ service }) { const methods = ["list", "get", "create", "update"]; if (!service || methods.some((method) => typeof service[method] !== "function")) throw new TypeError("Routing policy service is incomplete"); this.#service = service; }
  matches(method, pathname) { return (POLICIES.test(pathname) && ["GET", "POST"].includes(method)) || (POLICY.test(pathname) && ["GET", "PATCH"].includes(method)); }
  async handle({ method, pathname, body = null, context }) {
    if (POLICIES.test(pathname)) return method === "GET"
      ? { kind: "json", status: 200, body: await this.#service.list({ context }) }
      : { kind: "json", status: 201, body: await this.#service.create({ context, declaration: body }) };
    const match = POLICY.exec(pathname);
    if (match) return method === "GET"
      ? { kind: "json", status: 200, body: await this.#service.get({ context, policyId: match[1] }) }
      : { kind: "json", status: 200, body: await this.#service.update({ context, policyId: match[1], expectedRevision: body?.expectedRevision, declaration: body?.declaration }) };
    throw new PlatformError("not_found", "Routing policy endpoint was not found", { status: 404 });
  }
}
