import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const PATH = /^\/api\/v1\/external-object-proxy\/([A-Za-z0-9_-]{43})\/content$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }

function byteRange(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) fail("external_object_range_invalid", "External object range is invalid", 416);
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) fail("external_object_range_invalid", "External object range is invalid", 416);
  return { start: Number(match[1]), ...(match[2] ? { endInclusive: Number(match[2]) } : {}) };
}

export function matchesExternalObjectProxyRoute(method, pathname) {
  return new Set(["GET", "HEAD", "PUT"]).has(method) && PATH.test(pathname);
}

export class ExternalObjectProxyHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["head", "download", "upload"].some((method) => typeof service[method] !== "function")) {
      throw new TypeError("external object transfer service is incomplete");
    }
    this.#service = service;
  }

  matches(method, pathname) { return matchesExternalObjectProxyRoute(method, pathname); }
  bodyKind(method, pathname) { return method === "PUT" && PATH.test(pathname) ? "bytes" : "none"; }

  async handle({ method, pathname, body = null, headers = {} }) {
    const match = PATH.exec(pathname);
    if (!match) fail("not_found", "External object proxy endpoint was not found", 404);
    const ticket = match[1];
    if (method === "HEAD") {
      const metadata = await this.#service.head({ ticket });
      return { kind: "empty", status: 200, headers: {
        "accept-ranges": "bytes", "content-length": String(metadata.size),
        "content-type": metadata.contentType, etag: `\"sha256:${metadata.integrity.digest}\"`,
      } };
    }
    if (method === "GET") {
      const result = await this.#service.download({ ticket, range: byteRange(headers.range) });
      const responseHeaders = {
        "accept-ranges": "bytes", "content-length": String(result.content.byteLength),
        "content-type": result.metadata.contentType,
        etag: `\"sha256:${result.metadata.integrity.digest}\"`,
      };
      if (result.partial) responseHeaders["content-range"] = `bytes ${result.range.start}-${result.range.endInclusive}/${result.range.total}`;
      return { kind: "bytes", status: result.partial ? 206 : 200, body: result.content, headers: responseHeaders };
    }
    if (method === "PUT") {
      const sha256 = headers["x-content-sha256"];
      const contentType = headers["content-type"];
      if (Array.isArray(sha256) || !DIGEST.test(sha256 ?? "") || Array.isArray(contentType) || typeof contentType !== "string") {
        fail("external_object_upload_invalid", "Content-Type and x-content-sha256 are required");
      }
      const stored = await this.#service.upload({ ticket, contentType, content: body, sha256 });
      return { kind: "json", status: 201, body: {
        stored: true, size: stored.size,
        integrity: { algorithm: "sha256", digest: `sha256:${stored.integrity.digest}` },
      } };
    }
    fail("not_found", "External object proxy endpoint was not found", 404);
  }
}
