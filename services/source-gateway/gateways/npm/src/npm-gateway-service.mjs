import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code, message, status = 400, details = null) { throw new PlatformError(code, message, { status, details }); }
function safeText(value, field, maximum = 256) { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail("npm_package_invalid", `${field} is invalid`); return value.trim(); }
function uuid(value, field) { if (typeof value !== "string" || !UUID.test(value)) fail("npm_package_invalid", `${field} is invalid`); return value; }

export function normalizeNpmPackageName(value) {
  const name = safeText(value, "package", 214).toLowerCase();
  if (!/^(?:@[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}|[a-z0-9][a-z0-9._-]{0,199})$/.test(name)) fail("npm_package_invalid", "NPM package name is invalid");
  return name;
}

function stringMap(value, field, maximum = 512) {
  if (value == null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > maximum) fail("npm_package_invalid", `${field} is invalid`);
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, range]) => [normalizeNpmPackageName(name), safeText(range, `${field}.${name}`, 128)]).sort(([a], [b]) => a.localeCompare(b))));
}

function list(value, field, allowedPattern, maximum = 64) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !allowedPattern.test(item)) || new Set(value).size !== value.length) fail("npm_package_invalid", `${field} is invalid`);
  return Object.freeze([...value]);
}

function declaration(value) {
  if (!value || typeof value !== "object" || !VERSION.test(value.version) || !INTEGRITY.test(value.integrity) || (value.sha256 !== null && !SHA256.test(value.sha256)) || !Number.isSafeInteger(value.size) || value.size < 1) fail("npm_package_invalid", "NPM package artifact is invalid");
  const sourceKind = new Set(["hosted", "proxy-cache", "upstream", "mirror", "offline-media"]).has(value.sourceKind) ? value.sourceKind : fail("npm_package_invalid", "sourceKind is invalid");
  let upstreamUrl = null;
  if (value.upstreamUrl != null) { try { upstreamUrl = new URL(value.upstreamUrl); } catch { fail("npm_package_invalid", "upstreamUrl is invalid"); } if (upstreamUrl.protocol !== "https:" || upstreamUrl.username || upstreamUrl.password || upstreamUrl.hash) fail("npm_package_invalid", "upstreamUrl is invalid"); upstreamUrl = upstreamUrl.href; }
  if (new Set(["upstream", "mirror", "proxy-cache"]).has(sourceKind) !== (upstreamUrl !== null)) fail("npm_package_invalid", "external NPM artifacts require an upstream URL");
  if (!new Set(["upstream", "mirror", "proxy-cache"]).has(sourceKind) && value.sha256 === null) fail("npm_package_invalid", "internal NPM artifacts require SHA-256");
  if (typeof value.shasum !== "string" || !/^[0-9a-f]{40}$/.test(value.shasum)) fail("npm_package_invalid", "shasum is invalid");
  return Object.freeze({
    artifactId: uuid(value.artifactId, "artifactId"), packageName: normalizeNpmPackageName(value.packageName), version: value.version,
    integrity: value.integrity, sha256: value.sha256, shasum: value.shasum, size: value.size,
    sourceId: uuid(value.sourceId, "sourceId"), sourceKind, locationKey: safeText(value.locationKey, "locationKey", 512), upstreamUrl,
    dependencies: stringMap(value.dependencies, "dependencies"), optionalDependencies: stringMap(value.optionalDependencies, "optionalDependencies"),
    peerDependencies: stringMap(value.peerDependencies, "peerDependencies"), engines: stringMap(value.engines, "engines", 32),
    cpu: list(value.cpu, "cpu", /^!?[A-Za-z0-9_-]{1,32}$/), os: list(value.os, "os", /^!?[A-Za-z0-9_-]{1,32}$/),
    hasInstallScript: value.hasInstallScript === true, deprecated: value.deprecated == null ? null : safeText(value.deprecated, "deprecated", 512),
    signatureStatus: new Set(["verified", "unsigned", "invalid", "not-available"]).has(value.signatureStatus) ? value.signatureStatus : fail("npm_package_invalid", "signatureStatus is invalid"),
    scanStatus: new Set(["pending", "passed", "failed"]).has(value.scanStatus) ? value.scanStatus : fail("npm_package_invalid", "scanStatus is invalid"),
    license: value.license == null ? null : safeText(value.license, "license", 256),
    cachedAt: value.cachedAt == null ? null : new Date(value.cachedAt), importedAt: new Date(value.importedAt),
  });
}

function publicArtifact(value) { return Object.freeze({ ...structuredClone(value), cachedAt: value.cachedAt?.toISOString() ?? null, importedAt: value.importedAt.toISOString() }); }
function glob(pattern, value) { const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*"); return new RegExp(`^${escaped}$`, "i").test(value); }
function decision(name, version, policy) { let pin = null; for (const rule of policy.packageRules ?? []) { if (!glob(rule.pattern, name)) continue; if (rule.decision === "deny") return false; if (rule.decision === "pin") pin = rule.version; } return pin === null || pin === version; }
function sourceAllows(source, name) { return source.packageScopes.some((scope) => scope === "*" || glob(scope, name)); }
function availableOffline(item) { return item.cachedAt !== null && new Set(["hosted", "proxy-cache", "offline-media"]).has(item.sourceKind); }
function supportsPlatform(item, architecture) {
  const requiredCpu = architecture === "arm64" ? new Set(["arm64", "aarch64"]) : new Set(["x64", "amd64"]);
  if (item.cpu.some((value) => value.startsWith("!") && requiredCpu.has(value.slice(1)))) return false;
  if (item.cpu.some((value) => !value.startsWith("!")) && !item.cpu.some((value) => requiredCpu.has(value))) return false;
  if (item.os.includes("!linux") || (item.os.some((value) => !value.startsWith("!")) && !item.os.includes("linux"))) return false;
  return true;
}

function parts(version) { const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version); return match ? match.slice(1).map(Number) : null; }
function compare(left, right) { const a = parts(left), b = parts(right); if (!a || !b) return left.localeCompare(right); for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]; return left.localeCompare(right); }
function satisfies(version, range) {
  const normalized = range.trim();
  if (normalized === "*" || normalized === "latest" || normalized === "") return true;
  if (VERSION.test(normalized)) return version === normalized;
  const base = parts(normalized.slice(1)), candidate = parts(version); if (!base || !candidate) return false;
  if (normalized.startsWith("^")) return compare(version, `${base[0] + 1}.0.0`) < 0 && compare(version, base.join(".")) >= 0;
  if (normalized.startsWith("~")) return compare(version, `${base[0]}.${base[1] + 1}.0`) < 0 && compare(version, base.join(".")) >= 0;
  return normalized.split(/\s+/).every((token) => { const match = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/.exec(token); if (!match) return false; const compared = compare(version, match[2]); return match[1] === ">=" ? compared >= 0 : match[1] === "<=" ? compared <= 0 : match[1] === ">" ? compared > 0 : match[1] === "<" ? compared < 0 : compared === 0; });
}

export class NpmGatewayService {
  #catalog; #content; #policyResolver; #upstream; #clock; #audit; #idFactory;
  constructor({ catalog, content, policyResolver, upstream = null, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID }) {
    if (!catalog?.listPackages || !catalog?.listPackageArtifacts || !catalog?.findArtifact || !catalog?.putArtifact || !content?.get || !content?.put || !policyResolver?.resolve || (upstream !== null && (!upstream.listPackage || !upstream.fetchArtifact))) throw new TypeError("NPM gateway dependencies are incomplete");
    this.#catalog = catalog; this.#content = content; this.#policyResolver = policyResolver; this.#upstream = upstream; this.#clock = clock; this.#audit = audit; this.#idFactory = idFactory;
  }
  async importPackage({ context, artifact, bytes }) {
    if (!UUID.test(context?.identityId ?? "") || !context.permissions?.includes("source:manage")) fail("npm_source_permission_required", "Software source management permission is required", 403);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("npm_package_invalid", "package bytes are required");
    const normalized = declaration({ ...artifact, artifactId: artifact.artifactId ?? this.#idFactory(), cachedAt: this.#clock(), importedAt: this.#clock() });
    if (!new Set(["hosted", "offline-media", "proxy-cache"]).has(normalized.sourceKind)) fail("npm_package_invalid", "Imported package must belong to an internal, offline, or cache source");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`, shasum = createHash("sha1").update(bytes).digest("hex");
    if (normalized.size !== bytes.byteLength || normalized.integrity !== integrity || normalized.sha256 !== sha256 || normalized.shasum !== shasum) fail("npm_integrity_mismatch", "Imported NPM package integrity did not match", 422);
    await this.#content.put(normalized.locationKey, bytes); const stored = await this.#catalog.putArtifact(normalized);
    await this.#audit({ action: "npm_gateway.package_imported", actorIdentityId: context.identityId, artifactId: stored.artifactId, packageName: stored.packageName, version: stored.version, integrity: stored.integrity, sourceId: stored.sourceId, occurredAt: this.#clock().toISOString() });
    return publicArtifact(stored);
  }
  async refreshPackage({ context, packageName }) {
    const name = normalizeNpmPackageName(packageName), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "npm" });
    if (policy.offlineMode === "require-offline" || !this.#upstream) fail("npm_upstream_unavailable", "NPM upstream access is unavailable", 503);
    let imported = 0;
    for (const route of [...policy.sources].filter((item) => sourceAllows(item.source, name)).sort((a, b) => a.priority - b.priority)) {
      if (!route.source.enabled || route.source.onlineMode === "offline" || !new Set(["upstream", "mirror", "proxy-cache"]).has(route.source.kind)) continue;
      for (const item of await this.#upstream.listPackage({ source: route.source, packageName: name })) { if (!decision(name, item.version, policy)) continue; await this.#catalog.putArtifact(declaration({ ...item, artifactId: item.artifactId ?? this.#idFactory(), packageName: name, sourceId: route.sourceId, sourceKind: route.source.kind, cachedAt: null, importedAt: this.#clock() })); imported += 1; }
      if (imported) break;
    }
    return Object.freeze({ packageName: name, imported });
  }
  async packageDocument({ context, packageName, refresh = false, registryOrigin }) {
    const name = normalizeNpmPackageName(packageName), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "npm" }); let artifacts = await this.#catalog.listPackageArtifacts(name);
    if (refresh && artifacts.length === 0) { await this.refreshPackage({ context, packageName: name }); artifacts = await this.#catalog.listPackageArtifacts(name); }
    const priorities = new Map(policy.sources.filter((route) => sourceAllows(route.source, name)).map((route) => [route.sourceId, route.priority]));
    const ordered = artifacts.filter((item) => priorities.has(item.sourceId) && decision(name, item.version, policy) && supportsPlatform(item, context.architecture) && item.scanStatus === "passed" && item.signatureStatus !== "invalid" && (policy.offlineMode !== "require-offline" || availableOffline(item))).sort((a, b) => compare(a.version, b.version) || priorities.get(a.sourceId) - priorities.get(b.sourceId));
    const selectedByVersion = new Map(); for (const item of ordered) if (!selectedByVersion.has(item.version)) selectedByVersion.set(item.version, item);
    const permitted = [...selectedByVersion.values()].sort((a, b) => compare(a.version, b.version));
    const versions = {}, tags = {};
    for (const item of permitted) { versions[item.version] = { name, version: item.version, dependencies: item.dependencies, optionalDependencies: item.optionalDependencies, peerDependencies: item.peerDependencies, engines: item.engines, cpu: item.cpu, os: item.os, hasInstallScript: item.hasInstallScript, ...(item.deprecated ? { deprecated: item.deprecated } : {}), dist: { integrity: item.integrity, shasum: item.shasum, tarball: `${registryOrigin}/npm/tarballs/${item.artifactId}/${encodeURIComponent(name.split("/").at(-1))}-${item.version}.tgz` } }; tags.latest = item.version; }
    if (!Object.keys(versions).length) fail("npm_package_not_found", "NPM package has no permitted version", 404, { packageName: name });
    return Object.freeze({ name, modified: this.#clock().toISOString(), "dist-tags": Object.freeze(tags), versions: Object.freeze(versions) });
  }
  async fetchArtifact({ context, artifactId }) {
    const artifact = await this.#catalog.findArtifact(uuid(artifactId, "artifactId")); if (!artifact) fail("npm_package_not_found", "NPM package artifact was not found", 404);
    const policy = await this.#policyResolver.resolve({ ...context, ecosystem: "npm" }), route = policy.sources.find((item) => item.sourceId === artifact.sourceId && sourceAllows(item.source, artifact.packageName));
    if (!route || !decision(artifact.packageName, artifact.version, policy) || !supportsPlatform(artifact, context.architecture) || artifact.scanStatus !== "passed" || artifact.signatureStatus === "invalid") fail("npm_package_denied", "NPM package is not permitted", 403);
    let bytes = await this.#content.get(artifact.locationKey);
    if (bytes === null) { if (policy.offlineMode === "require-offline" || !this.#upstream) fail("npm_offline_missing", "NPM package is unavailable offline", 424); bytes = await this.#upstream.fetchArtifact({ source: route.source, artifact: publicArtifact(artifact) }); const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`; if (bytes.byteLength !== artifact.size || integrity !== artifact.integrity) fail("npm_upstream_integrity_failed", "Upstream NPM package integrity did not match", 502); artifact.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`; await this.#content.put(artifact.locationKey, bytes); artifact.cachedAt = this.#clock(); await this.#catalog.putArtifact(artifact); }
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity || (artifact.sha256 !== null && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifact.sha256)) fail("npm_cache_corrupted", "Cached NPM package failed integrity verification", 500);
    return Object.freeze({ artifact: publicArtifact(artifact), bytes: Buffer.from(bytes) });
  }
  async dependencyAvailability({ context, packageName, version = null, maximumDepth = 32 }) {
    const root = normalizeNpmPackageName(packageName), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "npm" }), queue = [{ name: root, range: version ?? "*", depth: 0, parent: null }], seen = new Set(), items = [];
    const priorities = new Map(policy.sources.map((route) => [route.sourceId, route.priority])); while (queue.length) { const request = queue.shift(), identity = `${request.name}@${request.range}`; if (seen.has(identity)) continue; seen.add(identity); const candidates = (await this.#catalog.listPackageArtifacts(request.name)).filter((item) => satisfies(item.version, request.range) && availableOffline(item) && supportsPlatform(item, context.architecture) && item.scanStatus === "passed" && item.signatureStatus !== "invalid" && policy.sources.some((route) => route.sourceId === item.sourceId && sourceAllows(route.source, request.name)) && decision(request.name, item.version, policy)).sort((a, b) => compare(b.version, a.version) || priorities.get(a.sourceId) - priorities.get(b.sourceId)); const selected = candidates[0] ?? null; items.push(Object.freeze({ packageName: request.name, range: request.range, depth: request.depth, parent: request.parent, availableOffline: selected !== null, selectedVersion: selected?.version ?? null, artifactId: selected?.artifactId ?? null, reason: selected ? "verified_package_available" : "compatible_package_missing" })); if (selected && request.depth < maximumDepth) for (const [name, range] of Object.entries(selected.dependencies)) queue.push({ name, range, depth: request.depth + 1, parent: identity }); }
    return Object.freeze({ ecosystem: "npm", root: Object.freeze({ packageName: root, version }), complete: items.every((item) => item.availableOffline), items: Object.freeze(items), missing: Object.freeze(items.filter((item) => !item.availableOffline)), policyKey: policy.policyKey });
  }
}
