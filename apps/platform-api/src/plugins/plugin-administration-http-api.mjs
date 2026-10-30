import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { PluginImportError } from "../../../../services/plugin-runtime/src/plugin-import-service.mjs";
import { PluginLifecycleError } from "../../../../services/plugin-runtime/src/plugin-lifecycle-service.mjs";

const PLUGINS = /^\/api\/v1\/admin\/plugins$/;
const IMPORTS = /^\/api\/v1\/admin\/plugins\/imports$/;
const ACTION = /^\/api\/v1\/admin\/plugins\/([a-z][a-z0-9.-]{2,127})\/(install|enable|disable|upgrade|uninstall)$/;

function mappedError(error) {
  if (error instanceof PlatformError) return error;
  if (error instanceof PluginImportError) {
    const status = error.retryable ? 503 : new Set(["plugin_version_conflict"]).has(error.code) ? 409 : 400;
    return new PlatformError(error.code, error.message, { status, retryable: error.retryable, details: { gate: error.gate } });
  }
  if (error instanceof PluginLifecycleError) {
    const status = error.code === "plugin_administrator_required" ? 403
      : error.retryable ? 503
        : new Set(["plugin_already_installed", "plugin_operation_in_progress", "protected_plugin_operation_denied", "protected_plugin_takeover_denied"]).has(error.code) ? 409 : 400;
    return new PlatformError(error.code, error.message, { status, retryable: error.retryable,
      details: { stage: error.stage, ...(error.causeCode ? { causeCode: error.causeCode } : {}) } });
  }
  return error;
}

export function matchesPluginAdministrationHttpRoute(method, pathname) {
  if (PLUGINS.test(pathname)) return method === "GET";
  if (IMPORTS.test(pathname)) return method === "POST";
  return method === "POST" && ACTION.test(pathname);
}

export class PluginAdministrationHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["overview", "importPlugin", "lifecycle"].some((method) => typeof service[method] !== "function")) {
      throw new TypeError("Plugin administration service is incomplete");
    }
    this.#service = service;
  }
  matches(method, pathname) { return matchesPluginAdministrationHttpRoute(method, pathname); }
  async handle({ method, pathname, context, body = null, requestId = null }) {
    try {
      if (method === "GET" && PLUGINS.test(pathname)) return { kind: "json", status: 200, body: await this.#service.overview({ context }) };
      if (method === "POST" && IMPORTS.test(pathname)) return { kind: "json", status: 201, body: await this.#service.importPlugin({ context, ...body }) };
      const match = ACTION.exec(pathname);
      if (method === "POST" && match) return { kind: "json", status: 200, body: await this.#service.lifecycle({ context, pluginId: match[1], operation: match[2],
        version: body?.version ?? null, operationKey: body?.operationKey ?? requestId, purgeData: body?.purgeData === true }) };
      throw new PlatformError("not_found", "Plugin administration endpoint was not found", { status: 404 });
    } catch (error) { throw mappedError(error); }
  }
}
