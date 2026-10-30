import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const OVERVIEW = /^\/api\/v1\/admin\/queues$/;
const POLICY = /^\/api\/v1\/admin\/queues\/policy$/;
const CANCEL = new RegExp(`^/api/v1/admin/jobs/${UUID}/cancel$`, "i");

export class QueueAdministrationHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["overview", "updatePolicy", "cancelJob"].some((method) => typeof service[method] !== "function")) throw new TypeError("queue administration service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) {
    return (method === "GET" && OVERVIEW.test(pathname)) || (method === "PUT" && POLICY.test(pathname)) || (method === "POST" && CANCEL.test(pathname));
  }
  async handle({ method, pathname, context, body = null, query = null }) {
    if (method === "GET" && OVERVIEW.test(pathname)) {
      const raw = query?.get?.("limit");
      const limit = raw == null ? 100 : Number(raw);
      return { kind: "json", status: 200, body: await this.#service.overview({ context, limit }) };
    }
    if (method === "PUT" && POLICY.test(pathname)) return { kind: "json", status: 200, body: await this.#service.updatePolicy({ context, expectedRevision: body?.expectedRevision, input: body?.policy }) };
    const match = CANCEL.exec(pathname);
    if (method === "POST" && match) return { kind: "json", status: 200, body: await this.#service.cancelJob({ context, jobId: match[1].toLowerCase(), confirmation: body?.confirmation }) };
    throw new PlatformError("not_found", "Queue administration endpoint was not found", { status: 404 });
  }
}
