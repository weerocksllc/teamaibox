import { PlatformError } from "../../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const ROOT = /^\/pip\/simple\/$/;
const PROJECT = /^\/pip\/simple\/([A-Za-z0-9._-]+)\/$/;
const FILE = new RegExp(`^/pip/files/${UUID}/([A-Za-z0-9][A-Za-z0-9._+-]{0,254})$`, "i");
const AVAILABILITY = /^\/pip\/availability\/([A-Za-z0-9._-]+)$/;

function htmlText(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function wantsJson(headers) { return String(headers?.accept ?? "").toLowerCase().includes("application/vnd.pypi.simple.v1+json"); }
function htmlDocument(body) { return `<!DOCTYPE html><html><head><meta name="pypi:repository-version" content="1.4"></head><body>${body}</body></html>`; }
function json(body) { return { kind: "bytes", status: 200, headers: { "content-type": "application/vnd.pypi.simple.v1+json" }, body: Buffer.from(JSON.stringify(body)) }; }
function html(body, headers = {}) { const vendor = String(headers?.accept ?? "").toLowerCase().includes("application/vnd.pypi.simple.v1+html"); return { kind: "bytes", status: 200, headers: { "content-type": vendor ? "application/vnd.pypi.simple.v1+html; charset=utf-8" : "text/html; charset=utf-8" }, body: Buffer.from(htmlDocument(body)) }; }

export class PipSimpleHttpApi {
  #service;
  constructor({ service }) {
    if (!service || ["listProjects", "listProject", "fetchArtifact", "dependencyAvailability"].some((method) => typeof service[method] !== "function")) throw new TypeError("PIP Simple service is incomplete");
    this.#service = service;
  }
  matches(method, pathname) { return method === "GET" && (ROOT.test(pathname) || PROJECT.test(pathname) || FILE.test(pathname) || AVAILABILITY.test(pathname)); }
  async handle({ pathname, headers = {}, context, query = new URLSearchParams() }) {
    if (ROOT.test(pathname)) {
      const result = await this.#service.listProjects({ context });
      if (wantsJson(headers)) return json(result);
      return html(result.projects.map((project) => `<a href="${htmlText(project.name)}/">${htmlText(project.name)}</a>`).join("\n"), headers);
    }
    const project = PROJECT.exec(pathname);
    if (project) {
      const result = await this.#service.listProject({ context, project: project[1], refresh: query.get("refresh") === "1" });
      const files = result.files.map((artifact) => ({ filename: artifact.filename, url: `/pip/files/${artifact.artifactId}/${encodeURIComponent(artifact.filename)}`, hashes: { sha256: artifact.sha256.slice(7) }, "requires-python": artifact.requiresPython, yanked: artifact.yankedReason ?? false, "core-metadata": artifact.coreMetadataSha256 ? { sha256: artifact.coreMetadataSha256.slice(7) } : false, size: artifact.size }));
      if (wantsJson(headers)) return json({ ...result, files });
      return html(files.map((file) => `<a href="${htmlText(file.url)}#sha256=${file.hashes.sha256}"${file["requires-python"] ? ` data-requires-python="${htmlText(file["requires-python"])}"` : ""}${file.yanked ? ` data-yanked="${htmlText(file.yanked)}"` : ""}>${htmlText(file.filename)}</a>`).join("\n"), headers);
    }
    const file = FILE.exec(pathname);
    if (file) {
      const result = await this.#service.fetchArtifact({ context, artifactId: file[1] });
      if (result.artifact.filename !== file[2]) throw new PlatformError("pip_artifact_not_found", "Python artifact was not found", { status: 404 });
      return { kind: "bytes", status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(result.bytes.byteLength), etag: `"${result.artifact.sha256}"`, "x-content-type-options": "nosniff" }, body: result.bytes };
    }
    const availability = AVAILABILITY.exec(pathname);
    if (availability) return json(await this.#service.dependencyAvailability({ context, project: availability[1], version: query.get("version"), maximumDepth: Number(query.get("maximum_depth") ?? 32) }));
    throw new PlatformError("not_found", "PIP endpoint was not found", { status: 404 });
  }
}
