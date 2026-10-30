import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const PROFILE_PATH = new RegExp(`^/api/v1/admin/model-profiles/${UUID}/lifecycle$`, "i");
const POLICY_PATH = new RegExp(`^/api/v1/admin/model-routing-policies/([a-z][a-z0-9_.-]{2,127})/experimental-profiles/${UUID}$`, "i");
const POLICY_LIST_PATH = /^\/api\/v1\/admin\/model-routing-policies\/([a-z][a-z0-9_.-]{2,127})\/experimental-profiles$/i;
const REPORT_PATH = /^\/api\/v1\/admin\/model-profiles\/by-key\/([a-z][a-z0-9_.-]{2,191})\/card$/i;
const PROFILE_LIST_PATH = /^\/api\/v1\/admin\/model-profiles$/i;

export function matchesModelLifecycleHttpRoute(method, pathname) {
  if (PROFILE_LIST_PATH.test(pathname)) return method === "GET";
  if (PROFILE_PATH.test(pathname)) return method === "GET" || method === "POST";
  if (POLICY_PATH.test(pathname)) return method === "PUT";
  if (POLICY_LIST_PATH.test(pathname)) return method === "GET";
  return false;
}

export class ModelLifecycleHttpApi {
  #service;
  #reportService;
  constructor({ service, reportService = null }) {
    const methods = ["getProfile", "listProfiles", "transition", "setExperimentalOptIn", "routingPolicy"];
    if (!service || methods.some((method) => typeof service[method] !== "function")) throw new TypeError("model lifecycle service is incomplete");
    this.#service = service;
    if (reportService !== null && typeof reportService.generateCard !== "function") throw new TypeError("model report service is incomplete");
    this.#reportService = reportService;
  }

  matches(method, pathname) {
    return matchesModelLifecycleHttpRoute(method, pathname)
      || Boolean(this.#reportService && method === "GET" && REPORT_PATH.test(pathname));
  }

  async handle({ method, pathname, body = null, context, query = new URLSearchParams() }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
    if (PROFILE_LIST_PATH.test(pathname) && method === "GET") {
      const rawLimit = query.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      return {
        kind: "json", status: 200,
        body: await this.#service.listProfiles(context, {
          limit,
          afterProfileKey: query.get("after"),
        }),
      };
    }
    const reportMatch = REPORT_PATH.exec(pathname);
    if (reportMatch && method === "GET" && this.#reportService) {
      return { kind: "json", status: 200, body: await this.#reportService.generateCard({ context, profileKey: reportMatch[1] }) };
    }
    const profileMatch = PROFILE_PATH.exec(pathname);
    if (profileMatch && method === "GET") {
      return { kind: "json", status: 200, body: await this.#service.getProfile(context, profileMatch[1]) };
    }
    if (profileMatch && method === "POST") {
      return {
        kind: "json", status: 200,
        body: await this.#service.transition({
          context, profileId: profileMatch[1], expectedRevision: body?.expectedRevision,
          nextState: body?.nextState, reasonKey: body?.reasonKey,
          evidenceRefs: body?.evidenceRefs ?? [], validationRunId: body?.validationRunId ?? null,
        }),
      };
    }
    const policyMatch = POLICY_PATH.exec(pathname);
    if (policyMatch && method === "PUT") {
      return {
        kind: "json", status: 200,
        body: await this.#service.setExperimentalOptIn({
          context, policyKey: policyMatch[1], profileId: policyMatch[2],
          environment: body?.environment, enabled: body?.enabled,
          reasonKey: body?.reasonKey, expiresAt: body?.expiresAt,
        }),
      };
    }
    const listMatch = POLICY_LIST_PATH.exec(pathname);
    if (listMatch && method === "GET") {
      if (!context.permissions?.includes("model:manage")) {
        throw new PlatformError("model_manager_required", "Model management permission is required", { status: 403 });
      }
      return {
        kind: "json", status: 200,
        body: await this.#service.routingPolicy({ policyKey: listMatch[1], environment: query.get("environment") }),
      };
    }
    throw new PlatformError("not_found", "Model lifecycle endpoint was not found", { status: 404 });
  }
}
