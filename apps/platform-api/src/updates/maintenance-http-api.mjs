import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const ADMINISTRATION = /^\/api\/v1\/admin\/updates$/;
const PLANS = /^\/api\/v1\/admin\/updates\/plans$/;
const PLAN = new RegExp(`^/api/v1/admin/updates/plans/${UUID}$`, "i");
const EXECUTE = new RegExp(`^/api/v1/admin/updates/plans/${UUID}/execute$`, "i");

export function matchesMaintenanceHttpRoute(method, pathname) {
  if (method === "GET" && ADMINISTRATION.test(pathname)) return true;
  if (method === "POST" && PLANS.test(pathname)) return true;
  if (method === "GET" && PLAN.test(pathname)) return true;
  return method === "POST" && EXECUTE.test(pathname);
}

export class MaintenanceHttpApi {
  #service;
  constructor({ service }) { if (!service || ["administration", "prepare", "get", "execute"].some((method) => typeof service[method] !== "function")) throw new TypeError("maintenance service is incomplete"); this.#service = service; }
  matches(method, pathname) { return matchesMaintenanceHttpRoute(method, pathname); }
  async handle({ method, pathname, context, body = null }) {
    if (method === "GET" && ADMINISTRATION.test(pathname)) return { kind: "json", status: 200, body: await this.#service.administration({ context }) };
    if (method === "POST" && PLANS.test(pathname)) return { kind: "json", status: 201, body: await this.#service.prepare({ context, kind: body?.kind, candidateKey: body?.candidate_key,
      targetNodeIds: body?.target_node_ids, strategy: body?.strategy, downtimeAcknowledged: body?.downtime_acknowledged, revalidationDecision: body?.revalidation_decision, operationKey: body?.operation_key }) };
    const execution = EXECUTE.exec(pathname); if (method === "POST" && execution) return { kind: "json", status: 200, body: await this.#service.execute({ context, planId: execution[1], expectedRevision: body?.expected_revision, confirmation: body?.confirmation }) };
    const plan = PLAN.exec(pathname); if (method === "GET" && plan) return { kind: "json", status: 200, body: await this.#service.get({ context, planId: plan[1] }) };
    throw new PlatformError("not_found", "Maintenance endpoint was not found", { status: 404 });
  }
}
