import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const PROVIDERS = /^\/api\/v1\/admin\/providers$/;
const PROVIDER = new RegExp(`^/api/v1/admin/providers/${UUID}$`, "i");
const ACTION = new RegExp(`^/api/v1/admin/providers/${UUID}/(enable|disable|test)$`, "i");
const ROTATE = new RegExp(`^/api/v1/admin/providers/${UUID}/credential/rotate$`, "i");

export function matchesProviderHttpRoute(method, pathname) {
  if (PROVIDERS.test(pathname)) return method === "GET" || method === "POST";
  if (PROVIDER.test(pathname)) return method === "GET" || method === "DELETE";
  return method === "POST" && (ACTION.test(pathname) || ROTATE.test(pathname));
}

export class ProviderHttpApi {
  #service;
  constructor({ service }) {
    const methods = ["list", "get", "create", "setEnabled", "testContract", "rotateCredential", "remove"];
    if (!service || methods.some((method) => typeof service[method] !== "function")) throw new TypeError("External provider service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesProviderHttpRoute(method, pathname); }
  async handle({ method, pathname, body = null, context }) {
    if (PROVIDERS.test(pathname)) {
      if (method === "GET") return { kind: "json", status: 200, body: await this.#service.list({ context }) };
      return { kind: "json", status: 201, body: await this.#service.create({ context, input: body }) };
    }
    const action = ACTION.exec(pathname);
    if (action) {
      if (action[2] === "test") return { kind: "json", status: 200, body: await this.#service.testContract({ context, providerId: action[1], expectedRevision: body?.expectedRevision }) };
      return { kind: "json", status: 200, body: await this.#service.setEnabled({ context, providerId: action[1], expectedRevision: body?.expectedRevision, enabled: action[2] === "enable" }) };
    }
    const rotate = ROTATE.exec(pathname);
    if (rotate) return { kind: "json", status: 200, body: await this.#service.rotateCredential({ context, providerId: rotate[1], credential: body?.credential }) };
    const provider = PROVIDER.exec(pathname);
    if (provider) {
      if (method === "DELETE") return { kind: "json", status: 200, body: await this.#service.remove({ context, providerId: provider[1], expectedRevision: body?.expectedRevision }) };
      return { kind: "json", status: 200, body: await this.#service.get({ context, providerId: provider[1] }) };
    }
    throw new PlatformError("not_found", "External provider endpoint was not found", { status: 404 });
  }
}
