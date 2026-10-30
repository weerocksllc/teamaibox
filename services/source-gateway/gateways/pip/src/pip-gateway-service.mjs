import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,127}$/;
const ARCHITECTURES = new Set(["arm64", "amd64", "all", "source"]);
const SOURCE_KINDS = new Set(["hosted", "proxy-cache", "upstream", "mirror", "offline-media"]);
const SCAN_STATES = new Set(["pending", "passed", "failed"]);
const SIGNATURE_STATES = new Set(["verified", "unsigned", "invalid", "not-available"]);

function fail(code, message, status = 400, details = null) { throw new PlatformError(code, message, { status, details }); }
function safeText(value, field, maximum = 256) { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail("pip_artifact_invalid", `${field} is invalid`); return value.trim(); }
function uuid(value, field) { if (typeof value !== "string" || !UUID.test(value)) fail("pip_artifact_invalid", `${field} is invalid`); return value; }
function integer(value, field, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail("pip_artifact_invalid", `${field} is invalid`); return value; }

export function normalizePythonProjectName(value) {
  const name = safeText(value, "project", 190);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) fail("pip_project_invalid", "Python project name is invalid");
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function architectureList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((item) => !ARCHITECTURES.has(item)) || new Set(value).size !== value.length) fail("pip_artifact_invalid", "architectures is invalid");
  return Object.freeze([...value].sort());
}

function dependencies(value) {
  if (!Array.isArray(value) || value.length > 512) fail("pip_artifact_invalid", "dependencies is invalid");
  const result = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("pip_artifact_invalid", `dependencies.${index} is invalid`);
    const specifier = item.specifier === null || item.specifier === undefined || item.specifier === "" ? null : safeText(item.specifier, `dependencies.${index}.specifier`, 128);
    const marker = item.marker === null || item.marker === undefined || item.marker === "" ? null : safeText(item.marker, `dependencies.${index}.marker`, 512);
    return Object.freeze({ project: normalizePythonProjectName(item.project), specifier, marker, optional: item.optional === true });
  });
  const identities = result.map((item) => `${item.project}\0${item.specifier}\0${item.marker}\0${item.optional}`);
  if (new Set(identities).size !== identities.length) fail("pip_artifact_invalid", "dependencies contains duplicates");
  return Object.freeze(result);
}

function declaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("pip_artifact_invalid", "artifact declaration is invalid");
  if (!FILENAME.test(value.filename)) fail("pip_artifact_invalid", "filename is invalid");
  if (!VERSION.test(value.version)) fail("pip_artifact_invalid", "version is invalid");
  if (!SHA256.test(value.sha256)) fail("pip_artifact_invalid", "sha256 is invalid");
  const sourceKind = SOURCE_KINDS.has(value.sourceKind) ? value.sourceKind : fail("pip_artifact_invalid", "sourceKind is invalid");
  const signatureStatus = SIGNATURE_STATES.has(value.signatureStatus) ? value.signatureStatus : fail("pip_artifact_invalid", "signatureStatus is invalid");
  const scanStatus = SCAN_STATES.has(value.scanStatus) ? value.scanStatus : fail("pip_artifact_invalid", "scanStatus is invalid");
  let upstreamUrl = null;
  if (value.upstreamUrl != null) {
    try { upstreamUrl = new URL(value.upstreamUrl); } catch { fail("pip_artifact_invalid", "upstreamUrl is invalid"); }
    if (upstreamUrl.protocol !== "https:" || upstreamUrl.username || upstreamUrl.password || upstreamUrl.hash) fail("pip_artifact_invalid", "upstreamUrl is invalid");
    upstreamUrl = upstreamUrl.href;
  }
  if (new Set(["upstream", "mirror", "proxy-cache"]).has(sourceKind) !== (upstreamUrl !== null)) fail("pip_artifact_invalid", "external artifacts require an upstream URL");
  return Object.freeze({
    artifactId: uuid(value.artifactId, "artifactId"), project: normalizePythonProjectName(value.project),
    version: value.version, filename: value.filename, sha256: value.sha256, size: integer(value.size, "size", 1),
    sourceId: uuid(value.sourceId, "sourceId"), sourceKind, locationKey: safeText(value.locationKey, "locationKey", 512), upstreamUrl,
    requiresPython: value.requiresPython == null ? null : safeText(value.requiresPython, "requiresPython", 128),
    dependencies: dependencies(value.dependencies ?? []), architectures: architectureList(value.architectures),
    yankedReason: value.yankedReason == null ? null : safeText(value.yankedReason, "yankedReason", 512),
    coreMetadataSha256: value.coreMetadataSha256 == null ? null : (SHA256.test(value.coreMetadataSha256) ? value.coreMetadataSha256 : fail("pip_artifact_invalid", "coreMetadataSha256 is invalid")),
    signatureStatus, scanStatus, license: value.license == null ? null : safeText(value.license, "license", 256),
    cachedAt: value.cachedAt == null ? null : new Date(value.cachedAt), importedAt: new Date(value.importedAt),
  });
}

function publicArtifact(value) {
  return Object.freeze({ ...structuredClone(value), cachedAt: value.cachedAt?.toISOString() ?? null, importedAt: value.importedAt.toISOString() });
}

function glob(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function policyDecision(project, version, policy) {
  let pin = null;
  for (const rule of policy.packageRules ?? []) {
    if (!glob(rule.pattern, project)) continue;
    if (rule.decision === "deny") return { allowed: false, reason: "package_denied", pin: null };
    if (rule.decision === "pin") pin = rule.version;
  }
  if (pin !== null && version !== pin) return { allowed: false, reason: "version_not_pinned", pin };
  return { allowed: true, reason: "allowed", pin };
}

function compatible(artifact, architecture) { return artifact.architectures.includes("all") || artifact.architectures.includes("source") || artifact.architectures.includes(architecture); }
function offlineArtifact(artifact) { return new Set(["hosted", "proxy-cache", "offline-media"]).has(artifact.sourceKind) && artifact.cachedAt !== null; }
function sourceAllowsProject(source, project) { return source.packageScopes.some((scope) => scope === "*" || glob(scope, project)); }

export class PipGatewayService {
  #catalog; #content; #policyResolver; #upstream; #clock; #audit; #idFactory;
  constructor({ catalog, content, policyResolver, upstream = null, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID }) {
    const catalogMethods = ["listProjects", "listProjectArtifacts", "findArtifact", "putArtifact"];
    if (!catalog || catalogMethods.some((method) => typeof catalog[method] !== "function") || !content?.get || !content?.put || !policyResolver?.resolve || (upstream !== null && (!upstream.listProject || !upstream.fetchArtifact))) throw new TypeError("PIP gateway dependencies are incomplete");
    this.#catalog = catalog; this.#content = content; this.#policyResolver = policyResolver; this.#upstream = upstream; this.#clock = clock; this.#audit = audit; this.#idFactory = idFactory;
  }

  async importArtifact({ context, artifact, bytes }) {
    if (!UUID.test(context?.identityId ?? "") || !context.permissions?.includes("source:manage")) fail("pip_source_permission_required", "Software source management permission is required", 403);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("pip_artifact_invalid", "artifact bytes are required");
    const normalized = declaration({ ...artifact, artifactId: artifact.artifactId ?? this.#idFactory(), cachedAt: this.#clock(), importedAt: this.#clock() });
    if (!new Set(["hosted", "offline-media", "proxy-cache"]).has(normalized.sourceKind)) fail("pip_artifact_invalid", "Imported content must belong to an internal, offline, or cache source");
    if (bytes.byteLength !== normalized.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== normalized.sha256) fail("pip_artifact_checksum_mismatch", "Imported Python artifact checksum did not match", 422);
    await this.#content.put(normalized.locationKey, bytes);
    const stored = await this.#catalog.putArtifact(normalized);
    await this.#audit({ action: "pip_gateway.artifact_imported", actorIdentityId: context.identityId, artifactId: stored.artifactId, project: stored.project, version: stored.version, sha256: stored.sha256, sourceId: stored.sourceId, sourceKind: stored.sourceKind, occurredAt: this.#clock().toISOString() });
    return publicArtifact(stored);
  }

  async listProjects({ context }) {
    const policy = await this.#policyResolver.resolve({ ...context, ecosystem: "pip" });
    const projects = (await this.#catalog.listProjects()).filter((project) => policyDecision(project, "0", policy).reason !== "package_denied");
    return Object.freeze({ meta: Object.freeze({ "api-version": "1.4" }), projects: Object.freeze(projects.map((name) => Object.freeze({ name }))) });
  }

  async refreshProject({ context, project }) {
    const normalized = normalizePythonProjectName(project), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "pip" });
    if (policy.offlineMode === "require-offline") fail("pip_upstream_disabled", "The active policy requires offline operation", 503);
    if (!this.#upstream) fail("pip_upstream_unavailable", "No PIP upstream adapter is configured", 503, { project: normalized });
    const sources = [...policy.sources].filter((route) => sourceAllowsProject(route.source, normalized)).sort((a, b) => a.priority - b.priority);
    let imported = 0;
    for (const route of sources) {
      const source = route.source;
      if (!source?.enabled || source.onlineMode === "offline" || !new Set(["upstream", "mirror", "proxy-cache"]).has(source.kind)) continue;
      const discovered = await this.#upstream.listProject({ source, project: normalized });
      for (const item of discovered) {
        const decision = policyDecision(normalized, item.version, policy);
        if (!decision.allowed) continue;
        await this.#catalog.putArtifact(declaration({ ...item, artifactId: item.artifactId ?? this.#idFactory(), project: normalized, sourceId: source.sourceId, sourceKind: source.kind, cachedAt: null, importedAt: this.#clock() }));
        imported += 1;
      }
      if (imported > 0) break;
    }
    await this.#audit({ action: "pip_gateway.project_refreshed", project: normalized, imported, occurredAt: this.#clock().toISOString() });
    return Object.freeze({ project: normalized, imported });
  }

  async listProject({ context, project, refresh = false }) {
    const normalized = normalizePythonProjectName(project), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "pip" });
    let artifacts = await this.#catalog.listProjectArtifacts(normalized);
    if (refresh && artifacts.length === 0) { await this.refreshProject({ context, project: normalized }); artifacts = await this.#catalog.listProjectArtifacts(normalized); }
    const sourcePriority = new Map(policy.sources.filter((route) => sourceAllowsProject(route.source, normalized)).map((route) => [route.sourceId, route.priority]));
    const ordered = artifacts.filter((artifact) => sourcePriority.has(artifact.sourceId) && artifact.scanStatus === "passed" && artifact.signatureStatus !== "invalid" && compatible(artifact, context.architecture))
      .filter((artifact) => policyDecision(normalized, artifact.version, policy).allowed)
      .filter((artifact) => policy.offlineMode !== "require-offline" || offlineArtifact(artifact))
      .sort((left, right) => (sourcePriority.get(left.sourceId) - sourcePriority.get(right.sourceId)) || left.filename.localeCompare(right.filename));
    const seenFilenames = new Set();
    const files = ordered.filter((artifact) => { if (seenFilenames.has(artifact.filename)) return false; seenFilenames.add(artifact.filename); return true; }).map(publicArtifact);
    return Object.freeze({ name: normalized, "project-status": Object.freeze({ status: "active" }), files: Object.freeze(files), meta: Object.freeze({ "api-version": "1.4" }) });
  }

  async fetchArtifact({ context, artifactId }) {
    const artifact = await this.#catalog.findArtifact(uuid(artifactId, "artifactId"));
    if (!artifact) fail("pip_artifact_not_found", "Python artifact was not found", 404);
    const policy = await this.#policyResolver.resolve({ ...context, ecosystem: "pip" });
    const route = policy.sources.find((item) => item.sourceId === artifact.sourceId && sourceAllowsProject(item.source, artifact.project));
    if (!route || !policyDecision(artifact.project, artifact.version, policy).allowed || !compatible(artifact, context.architecture) || artifact.scanStatus !== "passed" || artifact.signatureStatus === "invalid") fail("pip_artifact_denied", "Python artifact is not permitted for this environment", 403);
    let bytes = await this.#content.get(artifact.locationKey);
    if (bytes === null) {
      if (policy.offlineMode === "require-offline" || !this.#upstream) fail("pip_artifact_offline_missing", "Artifact is not available in the verified offline cache", 424, { project: artifact.project, version: artifact.version, filename: artifact.filename });
      bytes = await this.#upstream.fetchArtifact({ source: route.source, artifact: publicArtifact(artifact) });
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.size) fail("pip_upstream_integrity_failed", "Upstream returned an invalid artifact size", 502);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== artifact.sha256) fail("pip_upstream_integrity_failed", "Upstream artifact checksum did not match", 502);
      await this.#content.put(artifact.locationKey, bytes);
      artifact.cachedAt = this.#clock();
      await this.#catalog.putArtifact(artifact);
      await this.#audit({ action: "pip_gateway.artifact_cached", artifactId: artifact.artifactId, project: artifact.project, version: artifact.version, sha256: artifact.sha256, sourceId: artifact.sourceId, occurredAt: artifact.cachedAt.toISOString() });
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== artifact.sha256) fail("pip_cache_corrupted", "Cached Python artifact failed checksum verification", 500, { artifactId: artifact.artifactId });
    return Object.freeze({ artifact: publicArtifact(artifact), bytes: Buffer.from(bytes) });
  }

  async dependencyAvailability({ context, project, version = null, maximumDepth = 32 }) {
    const normalized = normalizePythonProjectName(project), policy = await this.#policyResolver.resolve({ ...context, ecosystem: "pip" });
    const priorities = new Map(policy.sources.map((route) => [route.sourceId, route.priority]));
    integer(maximumDepth, "maximumDepth", 1); if (maximumDepth > 64) fail("pip_dependency_request_invalid", "maximumDepth exceeds the supported bound");
    const queue = [{ project: normalized, version, depth: 0, parent: null }], seen = new Set(), items = [];
    while (queue.length) {
      const request = queue.shift(), identity = `${request.project}@${request.version ?? "*"}`;
      if (seen.has(identity)) continue; seen.add(identity);
      const candidates = (await this.#catalog.listProjectArtifacts(request.project)).filter((artifact) => (request.version === null || artifact.version === request.version) && compatible(artifact, context.architecture) && policy.sources.some((route) => route.sourceId === artifact.sourceId && sourceAllowsProject(route.source, request.project)) && policyDecision(request.project, artifact.version, policy).allowed && artifact.scanStatus === "passed" && artifact.signatureStatus !== "invalid").sort((left, right) => right.version.localeCompare(left.version) || priorities.get(left.sourceId) - priorities.get(right.sourceId));
      const available = candidates.find(offlineArtifact) ?? null;
      const item = Object.freeze({ project: request.project, requestedVersion: request.version, parent: request.parent, depth: request.depth, availableOffline: available !== null, selectedVersion: available?.version ?? null, artifactId: available?.artifactId ?? null, reason: available ? "verified_artifact_available" : candidates.length ? "artifact_not_cached" : "compatible_artifact_missing" });
      items.push(item);
      if (available && request.depth < maximumDepth) for (const dependency of available.dependencies) if (!dependency.optional) queue.push({ project: dependency.project, version: dependency.specifier?.startsWith("==") ? dependency.specifier.slice(2) : null, depth: request.depth + 1, parent: identity });
    }
    const missing = items.filter((item) => !item.availableOffline);
    return Object.freeze({ ecosystem: "pip", root: Object.freeze({ project: normalized, version }), architecture: context.architecture, complete: missing.length === 0, items: Object.freeze(items), missing: Object.freeze(missing), policyKey: policy.policyKey });
  }
}
