import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;

function invalid(message) { const error = new Error(message); error.code = "pip_upstream_invalid"; throw error; }
function normalized(value) { return String(value).toLowerCase().replace(/[-_.]+/g, "-"); }

function wheelVersion(project, filename) {
  const distribution = project.replaceAll("-", "_");
  const lower = filename.toLowerCase();
  if (lower.endsWith(".whl") && normalized(filename.split("-")[0]) === project) return filename.slice(distribution.length + 1).split("-")[0] || invalid("wheel version is unavailable");
  for (const suffix of [".tar.gz", ".tar.bz2", ".zip"]) {
    if (!lower.endsWith(suffix)) continue;
    const stem = filename.slice(0, -suffix.length), prefix = `${project}-`;
    if (normalized(stem).startsWith(prefix)) return stem.slice(stem.toLowerCase().lastIndexOf("-") + 1) || invalid("source version is unavailable");
  }
  invalid("distribution filename is not attributable to the project");
}

function architectures(filename) {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".whl")) return ["source"];
  if (lower.includes("-any.whl")) return ["all"];
  const result = [];
  if (/(?:aarch64|arm64)/.test(lower)) result.push("arm64");
  if (/(?:x86_64|amd64)/.test(lower)) result.push("amd64");
  return result.length ? result : invalid("wheel architecture is unsupported");
}

function parseRequirement(value) {
  const [requirement, ...markers] = value.split(";");
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(?:\(([^)]+)\)|([!<>=~].*))?\s*$/.exec(requirement);
  if (!match) return null;
  return { project: normalized(match[1]), specifier: (match[2] ?? match[3] ?? "").trim() || null, marker: markers.join(";").trim() || null, optional: /(?:^|\W)extra\s*==/.test(markers.join(";")) };
}

function parseMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024) invalid("core metadata is invalid");
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\u0000")) invalid("core metadata contains invalid bytes");
  const unfolded = text.replace(/\r?\n[ \t]+/g, " "), dependencies = [];
  let license = null;
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith("requires-dist:")) { const parsed = parseRequirement(line.slice(14).trim()); if (parsed) dependencies.push(parsed); }
    if (line.toLowerCase().startsWith("license-expression:")) license = line.slice(19).trim().slice(0, 256) || null;
  }
  return { dependencies, license };
}

async function responseBytes(response, maximumBytes) {
  if (!response.ok) invalid(`upstream returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) invalid("upstream response exceeds the configured limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) invalid("upstream response size is invalid");
  return bytes;
}

function urlAtOrigin(value, base, origins) {
  let parsed;
  try { parsed = new URL(value, base); } catch { invalid("upstream artifact URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !origins.has(parsed.origin)) invalid("upstream artifact URL is outside approved HTTPS origins");
  return parsed;
}

export class PipJsonUpstreamAdapter {
  #fetch; #authorization; #inspector; #allowedOrigins; #maximumFiles; #maximumArtifactBytes;
  constructor({ fetchImplementation = globalThis.fetch, authorizationProvider = { headersFor: async () => ({}) }, inspector, allowedArtifactOrigins = [], maximumFiles = 2_000, maximumArtifactBytes = 8 * 1024 * 1024 * 1024 }) {
    if (typeof fetchImplementation !== "function" || typeof authorizationProvider?.headersFor !== "function" || typeof inspector?.inspect !== "function" || !Array.isArray(allowedArtifactOrigins) || !Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || !Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1) throw new TypeError("PIP upstream adapter dependencies are incomplete");
    this.#fetch = fetchImplementation; this.#authorization = authorizationProvider; this.#inspector = inspector; this.#allowedOrigins = new Set(allowedArtifactOrigins.map((value) => new URL(value).origin)); this.#maximumFiles = maximumFiles; this.#maximumArtifactBytes = maximumArtifactBytes;
  }

  async #headers(source) { const value = await this.#authorization.headersFor({ secretKey: source.credentialSecretKey, sourceId: source.sourceId }); if (!value || typeof value !== "object" || Array.isArray(value)) invalid("upstream authorization headers are invalid"); return { accept: "application/vnd.pypi.simple.v1+json", ...value }; }

  async listProject({ source, project }) {
    const base = new URL(source.endpoint.url);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) invalid("PIP upstream base URL is invalid");
    const origins = new Set([base.origin, ...this.#allowedOrigins]), endpoint = new URL(`${encodeURIComponent(project)}/`, base);
    const response = await this.#fetch(endpoint, { method: "GET", redirect: "error", headers: await this.#headers(source) });
    if (!response.ok || !String(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/vnd.pypi.simple.v1+json")) invalid("PIP upstream did not return the JSON Simple API");
    const document = await response.json();
    if (!document || typeof document !== "object" || !Array.isArray(document.files) || document.files.length > this.#maximumFiles || !/^1\.[0-9]+$/.test(document.meta?.["api-version"] ?? "")) invalid("PIP upstream project response is invalid");
    const results = [];
    for (const file of document.files) {
      if (!file || typeof file.filename !== "string" || typeof file.url !== "string" || !SHA256.test(file.hashes?.sha256 ?? "") || !Number.isSafeInteger(file.size) || file.size < 1) invalid("PIP upstream file declaration is incomplete");
      const artifactUrl = urlAtOrigin(file.url, endpoint, origins), core = file["core-metadata"], coreDigest = core && typeof core === "object" && SHA256.test(core.sha256 ?? "") ? core.sha256 : null;
      let metadata = { dependencies: [], license: null };
      if (coreDigest) {
        const metadataUrl = urlAtOrigin(`${artifactUrl.href}.metadata`, endpoint, origins);
        const metadataBytes = await responseBytes(await this.#fetch(metadataUrl, { method: "GET", redirect: "error", headers: await this.#headers(source) }), 4 * 1024 * 1024);
        if (createHash("sha256").update(metadataBytes).digest("hex") !== coreDigest) invalid("PIP core metadata checksum did not match");
        metadata = parseMetadata(metadataBytes);
      }
      const inspection = await this.#inspector.inspect({ sourceId: source.sourceId, project, filename: file.filename, sha256: `sha256:${file.hashes.sha256}`, size: file.size, metadata });
      if (!inspection || !new Set(["pending", "passed", "failed"]).has(inspection.scanStatus) || !new Set(["verified", "unsigned", "invalid", "not-available"]).has(inspection.signatureStatus)) invalid("PIP artifact inspection result is invalid");
      results.push({ project, version: wheelVersion(project, file.filename), filename: file.filename, sha256: `sha256:${file.hashes.sha256}`, size: file.size, locationKey: `pip/cache/${source.sourceId}/${project}/${file.hashes.sha256}`, requiresPython: file["requires-python"] ?? null, dependencies: metadata.dependencies, architectures: architectures(file.filename), yankedReason: typeof file.yanked === "string" ? file.yanked : null, coreMetadataSha256: coreDigest ? `sha256:${coreDigest}` : null, signatureStatus: inspection.signatureStatus, scanStatus: inspection.scanStatus, license: inspection.license ?? metadata.license, upstreamUrl: artifactUrl.href });
    }
    return results;
  }

  async fetchArtifact({ source, artifact }) {
    if (typeof artifact.upstreamUrl !== "string") invalid("PIP artifact has no approved upstream URL");
    const base = new URL(source.endpoint.url), url = urlAtOrigin(artifact.upstreamUrl, base, new Set([base.origin, ...this.#allowedOrigins]));
    return responseBytes(await this.#fetch(url, { method: "GET", redirect: "error", headers: await this.#headers(source) }), this.#maximumArtifactBytes);
  }
}
