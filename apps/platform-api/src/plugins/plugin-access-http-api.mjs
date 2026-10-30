import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { DelegatedUserTokenError } from "../../../../services/plugin-runtime/src/delegated-user-token-service.mjs";

const PLUGIN_ID = "([a-z][a-z0-9.-]{2,127})";
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const ISSUE = new RegExp(`^/api/v1/plugins/${PLUGIN_ID}/delegations$`);
const REVOKE = new RegExp(`^/api/v1/plugin-delegations/${UUID}$`);
const INVOKE = /^\/api\/plugin\/v1\/invoke$/;
const PLUGIN_HEADER = /^[a-z][a-z0-9.-]{2,127}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{2,127}$/;

function mapped(error) {
  if (error instanceof PlatformError) return error;
  if (error instanceof DelegatedUserTokenError) {
    return new PlatformError(error.code, error.message, { status: error.status, retryable: error.retryable });
  }
  return error;
}

function bearer(value) {
  const match = /^Bearer (taibp_v1_[A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match) throw new PlatformError("plugin_delegation_invalid", "Delegated token is invalid or expired", { status: 401 });
  return match[1];
}

export class PluginAccessHttpApi {
  #delegations;
  #dispatcher;
  constructor({ delegations, dispatcher }) {
    if (!delegations || ["issue", "authenticate", "revoke"].some((method) => typeof delegations[method] !== "function")
      || !dispatcher || typeof dispatcher.invoke !== "function") throw new TypeError("Plugin access HTTP dependencies are incomplete");
    this.#delegations = delegations; this.#dispatcher = dispatcher;
  }
  matches(method, pathname) {
    return (method === "POST" && (ISSUE.test(pathname) || INVOKE.test(pathname))) || (method === "DELETE" && REVOKE.test(pathname));
  }
  routeKind(method, pathname) { return method === "POST" && INVOKE.test(pathname) ? "delegated" : "user"; }
  async handle({ method, pathname, context = null, body = null, headers = {} }) {
    try {
      let match = ISSUE.exec(pathname);
      if (method === "POST" && match) {
        const issued = await this.#delegations.issue({ context, pluginId: match[1], grants: body?.grants, ttlSeconds: body?.ttlSeconds });
        return { kind: "json", status: 201, body: { object: "plugin.delegation", token: issued.token, ...issued.delegation } };
      }
      match = REVOKE.exec(pathname);
      if (method === "DELETE" && match) {
        const revoked = await this.#delegations.revoke({ context, delegationId: match[1] });
        return { kind: "json", status: 200, body: { object: "plugin.delegation.revocation", ...revoked } };
      }
      if (method === "POST" && INVOKE.test(pathname)) {
        const pluginId = headers["x-teamaibox-plugin-id"];
        if (Array.isArray(pluginId) || typeof pluginId !== "string" || !PLUGIN_HEADER.test(pluginId)
          || !OPERATION.test(body?.operation ?? "")) {
          throw new PlatformError("plugin_invoke_invalid", "Delegated plugin request is invalid", { status: 400 });
        }
        const delegated = await this.#delegations.authenticate({ token: bearer(headers.authorization), pluginId,
          requiredScope: body?.scope, resource: body?.resource });
        const result = await this.#dispatcher.invoke({ delegated, operation: body.operation, body: body?.body ?? null,
          idempotencyKey: headers["idempotency-key"] ?? null });
        return { kind: "json", status: 200, body: result };
      }
      throw new PlatformError("not_found", "Plugin access endpoint was not found", { status: 404 });
    } catch (error) { throw mapped(error); }
  }
}
