import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const CATALOG = /^\/api\/v1\/applications$/;
const INTERNAL_ROUTE = /^\/internal\/v1\/plugin-routes\/([a-z][a-z0-9_.-]{1,127})$/;
const CONTENT = /^\/plugins\/([a-z][a-z0-9_.-]{1,127})(?:\/.*)?$/;

export function matchesApplicationCatalogHttpRoute(method, pathname) {
  return (method === "GET" && (CATALOG.test(pathname) || INTERNAL_ROUTE.test(pathname)))
    || (new Set(["GET", "HEAD"]).has(method) && CONTENT.test(pathname));
}

export class ApplicationCatalogHttpApi {
  #service;
  constructor({ service }) {
    if (!service?.list || !service?.resolveProxyRoute || !service?.fetchProxyContent) throw new TypeError("Application catalog service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesApplicationCatalogHttpRoute(method, pathname); }
  async handle({ method, pathname, context, target = pathname }) {
    if (!matchesApplicationCatalogHttpRoute(method, pathname)) {
      throw new PlatformError("not_found", "Application catalog endpoint was not found", { status: 404 });
    }
    if (CATALOG.test(pathname)) return { kind: "json", status: 200, body: await this.#service.list({ context }) };
    const contentPluginKey = CONTENT.exec(pathname)?.[1];
    if (contentPluginKey) {
      const content = await this.#service.fetchProxyContent({ context, pluginKey: contentPluginKey, method, path: target });
      if (!content) throw new PlatformError("plugin_route_unavailable", "Application plugin route is unavailable", { status: 404 });
      return { kind: "bytes", status: content.status, body: content.body, headers: content.headers };
    }
    const pluginKey = INTERNAL_ROUTE.exec(pathname)?.[1];
    const route = await this.#service.resolveProxyRoute({ context, pluginKey });
    if (!route) throw new PlatformError("plugin_route_unavailable", "Application plugin route is unavailable", { status: 404 });
    return { kind: "json", status: 200, body: route };
  }
}
