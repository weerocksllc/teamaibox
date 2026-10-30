import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const OVERVIEW = /^\/api\/v1\/admin\/source-center\/overview$/;
const DATA_PLANES = /^\/api\/v1\/admin\/source-center\/data-planes$/;
const SOURCES = /^\/api\/v1\/admin\/source-center\/sources$/;
const SOURCE = new RegExp(`^/api/v1/admin/source-center/sources/${UUID}$`, "i");
const HEALTH = new RegExp(`^/api/v1/admin/source-center/sources/${UUID}/health$`, "i");
const POLICIES = /^\/api\/v1\/admin\/source-center\/policies$/;
const POLICY = new RegExp(`^/api/v1/admin/source-center/policies/${UUID}$`, "i");

export function matchesSourceCenterHttpRoute(method, pathname) {
  if (OVERVIEW.test(pathname) || DATA_PLANES.test(pathname)) return method === "GET";
  if (SOURCES.test(pathname) || POLICIES.test(pathname)) return method === "GET" || method === "POST";
  if (SOURCE.test(pathname) || POLICY.test(pathname)) return method === "GET" || method === "PATCH";
  return HEALTH.test(pathname) && method === "POST";
}

export class SourceCenterHttpApi {
  #service; #dataPlaneStatus;
  constructor({ service, dataPlaneStatus = null }) {
    const methods = ["overview", "listSources", "getSource", "createSource", "updateSource", "reportHealth", "listPolicies", "getPolicy", "createPolicy", "updatePolicy"];
    if (!service || methods.some((method) => typeof service[method] !== "function")) throw new TypeError("Source Center service is incomplete");
    this.#service = service;
    if (dataPlaneStatus !== null && typeof dataPlaneStatus.getStatus !== "function") throw new TypeError("Source data-plane status provider is invalid");
    this.#dataPlaneStatus = dataPlaneStatus;
  }
  matches(method, pathname) { return matchesSourceCenterHttpRoute(method, pathname); }
  async handle({ method, pathname, body = null, context, query = new URLSearchParams() }) {
    const ecosystem = query.get("ecosystem");
    if (OVERVIEW.test(pathname)) return { kind: "json", status: 200, body: await this.#service.overview({ context }) };
    if (DATA_PLANES.test(pathname)) {
      await this.#service.overview({ context });
      return { kind: "json", status: 200, body: this.#dataPlaneStatus ? await this.#dataPlaneStatus.getStatus() : {
        schemaVersion: 1, state: "unavailable", observedAt: new Date().toISOString(), errorCode: "source_gateway_not_configured",
        ecosystems: Object.fromEntries(["pip", "npm", "apt"].map((item) => [item, { requests: null, cacheHits: null, upstreamFetches: null, upstreamBytes: null }])),
      } };
    }
    if (SOURCES.test(pathname)) {
      if (method === "GET") return { kind: "json", status: 200, body: await this.#service.listSources({ context, ecosystem }) };
      return { kind: "json", status: 201, body: await this.#service.createSource({ context, declaration: body }) };
    }
    const health = HEALTH.exec(pathname);
    if (health) return { kind: "json", status: 200, body: await this.#service.reportHealth({ context, sourceId: health[1], expectedRevision: body?.expectedRevision, observation: body?.observation }) };
    const source = SOURCE.exec(pathname);
    if (source) {
      if (method === "GET") return { kind: "json", status: 200, body: await this.#service.getSource({ context, sourceId: source[1] }) };
      return { kind: "json", status: 200, body: await this.#service.updateSource({ context, sourceId: source[1], expectedRevision: body?.expectedRevision, declaration: body?.declaration }) };
    }
    if (POLICIES.test(pathname)) {
      if (method === "GET") return { kind: "json", status: 200, body: await this.#service.listPolicies({ context, ecosystem }) };
      return { kind: "json", status: 201, body: await this.#service.createPolicy({ context, declaration: body }) };
    }
    const policy = POLICY.exec(pathname);
    if (policy) {
      if (method === "GET") return { kind: "json", status: 200, body: await this.#service.getPolicy({ context, policyId: policy[1] }) };
      return { kind: "json", status: 200, body: await this.#service.updatePolicy({ context, policyId: policy[1], expectedRevision: body?.expectedRevision, declaration: body?.declaration }) };
    }
    throw new PlatformError("not_found", "Source Center endpoint was not found", { status: 404 });
  }
}
