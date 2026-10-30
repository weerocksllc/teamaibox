import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const MEDIA = /^\/api\/v1\/admin\/source-center\/offline-media$/;
const DISCOVER = /^\/api\/v1\/admin\/source-center\/offline-media\/discover$/;
const ITEM = new RegExp(`^/api/v1/admin/source-center/offline-media/${UUID}$`, "i");
const APPROVE = new RegExp(`^/api/v1/admin/source-center/offline-media/${UUID}/approve$`, "i");
const ARTIFACTS = new RegExp(`^/api/v1/admin/source-center/offline-media/${UUID}/artifacts$`, "i");

export function matchesOfflineMediaHttpRoute(method, pathname) {
  if (MEDIA.test(pathname)) return method === "GET";
  if (DISCOVER.test(pathname)) return method === "POST";
  if (ITEM.test(pathname) || ARTIFACTS.test(pathname)) return method === "GET";
  return APPROVE.test(pathname) && method === "POST";
}

export class OfflineMediaHttpApi {
  #service;
  constructor({ service }) {
    const methods = ["discover", "list", "get", "approve", "artifacts"];
    if (!service || methods.some((method) => typeof service[method] !== "function")) throw new TypeError("Offline media service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return matchesOfflineMediaHttpRoute(method, pathname); }
  async handle({ method, pathname, body = null, context, query = new URLSearchParams() }) {
    if (MEDIA.test(pathname)) return { kind: "json", status: 200, body: await this.#service.list({ context, nodeId: query.get("nodeId") }) };
    if (DISCOVER.test(pathname)) return { kind: "json", status: 200, body: await this.#service.discover({ context, nodeId: body?.nodeId }) };
    const approve = APPROVE.exec(pathname);
    if (approve) return { kind: "json", status: 200, body: await this.#service.approve({ context, mediaId: approve[1], expectedRevision: body?.expectedRevision, expectedManifestSha256: body?.expectedManifestSha256 }) };
    const artifacts = ARTIFACTS.exec(pathname);
    if (artifacts) return { kind: "json", status: 200, body: await this.#service.artifacts({ context, mediaId: artifacts[1] }) };
    const item = ITEM.exec(pathname);
    if (item) return { kind: "json", status: 200, body: await this.#service.get({ context, mediaId: item[1] }) };
    throw new PlatformError("not_found", "Offline media endpoint was not found", { status: 404 });
  }
}
