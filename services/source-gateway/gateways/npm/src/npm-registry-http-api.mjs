import { PlatformError } from "../../../../../packages/observability/src/index.mjs";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const TARBALL = new RegExp(`^/npm/tarballs/${UUID}/([A-Za-z0-9@._+-]+\\.tgz)$`, "i");
const AVAILABILITY = /^\/npm\/availability\/(.+)$/;

function packageFromPath(pathname) { if (!pathname.startsWith("/npm/registry/")) return null; const encoded = pathname.slice(14); if (!encoded || encoded.includes("/")) return null; try { return decodeURIComponent(encoded); } catch { return null; } }

export class NpmRegistryHttpApi {
  #service;
  constructor({ service }) { if (!service?.packageDocument || !service?.fetchArtifact || !service?.dependencyAvailability) throw new TypeError("NPM registry service is incomplete"); this.#service = service; }
  matches(method, pathname) { return method === "GET" && (packageFromPath(pathname) !== null || TARBALL.test(pathname) || AVAILABILITY.test(pathname)); }
  async handle({ pathname, context, query = new URLSearchParams(), registryOrigin }) {
    const packageName = packageFromPath(pathname); if (packageName !== null) return { kind: "bytes", status: 200, headers: { "content-type": "application/vnd.npm.install-v1+json" }, body: Buffer.from(JSON.stringify(await this.#service.packageDocument({ context, packageName, refresh: query.get("refresh") === "1", registryOrigin }))) };
    const tarball = TARBALL.exec(pathname); if (tarball) { const result = await this.#service.fetchArtifact({ context, artifactId: tarball[1] }); return { kind: "bytes", status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(result.bytes.byteLength), etag: `"${result.artifact.integrity}"` }, body: result.bytes }; }
    const availability = AVAILABILITY.exec(pathname); if (availability) { let name; try { name = decodeURIComponent(availability[1]); } catch { throw new PlatformError("npm_package_invalid", "NPM package is invalid", { status: 400 }); } return { kind: "bytes", status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(await this.#service.dependencyAvailability({ context, packageName: name, version: query.get("version") }))) }; }
    throw new PlatformError("not_found", "NPM registry route was not found", { status: 404 });
  }
}
