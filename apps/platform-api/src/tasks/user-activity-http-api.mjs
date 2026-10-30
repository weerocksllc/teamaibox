import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const OVERVIEW = /^\/api\/v1\/user\/activity$/;
const CANCEL = /^\/api\/v1\/user\/tasks\/([0-9a-f-]{36})\/cancel$/i;
const RESULT = /^\/api\/v1\/user\/tasks\/([0-9a-f-]{36})\/result$/i;

export function matchesUserActivityHttpRoute(method, pathname) {
  return (method === "GET" && (OVERVIEW.test(pathname) || RESULT.test(pathname)))
    || (method === "POST" && CANCEL.test(pathname));
}

export class UserActivityHttpApi {
  #service;
  constructor({ service }) {
    if (!service?.overview || !service?.cancelOwn || !service?.resultOwn) throw new TypeError("User activity service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesUserActivityHttpRoute(method, pathname); }
  async handle({ method, pathname, context }) {
    if (method === "GET" && OVERVIEW.test(pathname)) return { kind: "json", status: 200, body: await this.#service.overview({ context }) };
    const result = RESULT.exec(pathname);
    if (method === "GET" && result) {
      const reference = await this.#service.resultOwn({ context, taskId: result[1] });
      return { kind: "redirect", status: 302, body: null, headers: {
        location: `/api/v1/objects/references/${reference.referenceId}/content?download=1`,
        "cache-control": "no-store",
      } };
    }
    const cancel = CANCEL.exec(pathname);
    if (method === "POST" && cancel) return { kind: "json", status: 202, body: await this.#service.cancelOwn({ context, taskId: cancel[1] }) };
    throw new PlatformError("not_found", "User activity endpoint was not found", { status: 404 });
  }
}
