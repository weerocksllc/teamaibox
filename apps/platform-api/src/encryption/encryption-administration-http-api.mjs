import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const STATUS = /^\/api\/v1\/admin\/encryption(?:\/status)?$/;
const ENABLE = /^\/api\/v1\/admin\/encryption\/protection\/enable$/;

export class EncryptionAdministrationHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["overview", "prepare", "commit"].some((method) => typeof service[method] !== "function")) {
      throw new TypeError("encryption administration service is incomplete");
    }
    this.#service = service;
  }
  matches(method, pathname) {
    return (method === "GET" && STATUS.test(pathname)) || (method === "POST" && ENABLE.test(pathname));
  }
  async handle({ method, pathname, context, body = null }) {
    if (method === "GET" && STATUS.test(pathname)) return { kind: "json", status: 200, body: await this.#service.overview({ context }) };
    if (method === "POST" && ENABLE.test(pathname) && body?.phase === "prepare") {
      return { kind: "json", status: 201, body: await this.#service.prepare({ context, input: {
        mode: body.mode,
        recoveryVerificationId: body.recovery_verification_id,
        selectedVerificationId: body.selected_verification_id,
        requestId: body.request_id,
        confirmation: body.confirmation,
      } }) };
    }
    if (method === "POST" && ENABLE.test(pathname) && body?.phase === "commit") {
      return { kind: "json", status: 200, body: await this.#service.commit({ context, input: {
        planId: body.plan_id,
        expectedRevision: body.expected_revision,
        confirmation: body.confirmation,
      } }) };
    }
    throw new PlatformError("not_found", "Encryption administration endpoint was not found", { status: 404 });
  }
}
