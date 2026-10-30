import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryPipCatalog, MemoryPipContentStore } from "../gateways/pip/src/memory-pip-catalog.mjs";
import { normalizePythonProjectName, PipGatewayService } from "../gateways/pip/src/pip-gateway-service.mjs";
import { PipSimpleHttpApi } from "../gateways/pip/src/pip-simple-http-api.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const HOSTED = "018f6f18-24d7-7c21-9b62-8c0174199501";
const UPSTREAM = "018f6f18-24d7-7c21-9b62-8c0174199502";
const context = { identityId: ADMIN, permissions: ["source:manage"], environment: "agent", architecture: "arm64", teamKey: "engineering", sandboxProfileKey: "python" };
const bytes = Buffer.from("verified-wheel-content");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function artifact(overrides = {}) {
  return {
    project: "Demo_Package", version: "1.0.0", filename: "demo_package-1.0.0-py3-none-any.whl",
    sha256, size: bytes.byteLength, sourceId: HOSTED, sourceKind: "hosted", locationKey: "pip/demo/1.0.0/wheel",
    requiresPython: ">=3.11", dependencies: [], architectures: ["all"], yankedReason: null,
    coreMetadataSha256: null, signatureStatus: "not-available", scanStatus: "passed", license: "MIT",
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    policyKey: "pip.agent.arm64", offlineMode: "allow-online", packageRules: [],
    sources: [
      { sourceId: HOSTED, priority: 10, source: { sourceId: HOSTED, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } },
      { sourceId: UPSTREAM, priority: 20, source: { sourceId: UPSTREAM, kind: "upstream", enabled: true, onlineMode: "online", endpoint: { url: "https://pypi.org/simple/" }, credentialSecretKey: null, packageScopes: ["*"] } },
    ],
    ...overrides,
  };
}

function fixture({ selectedPolicy = policy(), upstream = null } = {}) {
  const catalog = new MemoryPipCatalog(), content = new MemoryPipContentStore(), audits = [];
  const service = new PipGatewayService({ catalog, content, policyResolver: { resolve: async () => selectedPolicy }, upstream, audit: async (event) => audits.push(event), clock: () => new Date("2026-08-11T07:00:00.000Z") });
  return { catalog, content, service, audits };
}

test("normalizes Python distribution names according to the Simple API", () => {
  assert.equal(normalizePythonProjectName("Friendly_Bard...Core"), "friendly-bard-core");
  assert.throws(() => normalizePythonProjectName("../escape"), { code: "pip_project_invalid" });
});

test("hosted artifact import verifies bytes and serves PEP 691 JSON plus frozen HTML", async () => {
  const { service, audits } = fixture();
  const imported = await service.importArtifact({ context, artifact: artifact(), bytes });
  assert.equal(imported.project, "demo-package");
  const api = new PipSimpleHttpApi({ service });
  const json = await api.handle({ pathname: "/pip/simple/demo-package/", headers: { accept: "application/vnd.pypi.simple.v1+json" }, context });
  assert.equal(json.headers["content-type"], "application/vnd.pypi.simple.v1+json");
  const document = JSON.parse(json.body);
  assert.equal(document.meta["api-version"], "1.4");
  assert.equal(document.files[0].hashes.sha256, sha256.slice(7));
  assert.equal(document.files[0]["requires-python"], ">=3.11");
  const html = await api.handle({ pathname: "/pip/simple/demo-package/", headers: { accept: "text/html" }, context });
  assert.match(html.body.toString(), /pypi:repository-version/);
  assert.match(html.body.toString(), new RegExp(`#sha256=${sha256.slice(7)}`));
  const downloaded = await api.handle({ pathname: `/pip/files/${imported.artifactId}/${imported.filename}`, context });
  assert.deepEqual(downloaded.body, bytes);
  assert.equal(audits[0].action, "pip_gateway.artifact_imported");
});

test("proxy cache verifies upstream checksums before making bytes reusable", async () => {
  let fetches = 0;
  const upstream = {
    listProject: async () => [artifact({ sourceId: undefined, sourceKind: undefined, locationKey: "pip/cache/demo.whl", upstreamUrl: "https://files.pythonhosted.org/demo.whl" })],
    fetchArtifact: async () => { fetches += 1; return bytes; },
  };
  const selectedPolicy = policy({ sources: [{ sourceId: UPSTREAM, priority: 1, source: { sourceId: UPSTREAM, kind: "upstream", enabled: true, onlineMode: "online", packageScopes: ["*"] } }] });
  const { service } = fixture({ selectedPolicy, upstream });
  await service.refreshProject({ context, project: "demo-package" });
  const result = await service.listProject({ context, project: "demo-package" });
  assert.equal(result.files.length, 1);
  const first = await service.fetchArtifact({ context, artifactId: result.files[0].artifactId });
  const second = await service.fetchArtifact({ context, artifactId: result.files[0].artifactId });
  assert.deepEqual(first.bytes, bytes); assert.deepEqual(second.bytes, bytes); assert.equal(fetches, 1);
});

test("source priority selects one deterministic artifact when sources publish the same filename", async () => {
  const alternate = Buffer.from("alternate-wheel-content");
  const selectedPolicy = policy({ sources: [
    { sourceId: HOSTED, priority: 20, source: { sourceId: HOSTED, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } },
    { sourceId: UPSTREAM, priority: 10, source: { sourceId: UPSTREAM, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } },
  ] });
  const { service } = fixture({ selectedPolicy });
  await service.importArtifact({ context, artifact: artifact(), bytes });
  const preferred = await service.importArtifact({ context, artifact: artifact({ sourceId: UPSTREAM, locationKey: "pip/preferred/wheel", sha256: `sha256:${createHash("sha256").update(alternate).digest("hex")}`, size: alternate.length }), bytes: alternate });
  const result = await service.listProject({ context, project: "demo-package" });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].artifactId, preferred.artifactId);
});

test("checksum mismatch and a corrupted cache fail closed", async () => {
  const corruptUpstream = { listProject: async () => [], fetchArtifact: async () => Buffer.from("wrong") };
  const selectedPolicy = policy({ sources: [{ sourceId: UPSTREAM, priority: 1, source: { sourceId: UPSTREAM, kind: "upstream", enabled: true, onlineMode: "online", packageScopes: ["*"] } }] });
  const { service, catalog } = fixture({ selectedPolicy, upstream: corruptUpstream });
  const stored = { ...artifact({ artifactId: randomUUID(), sourceId: UPSTREAM, sourceKind: "upstream", cachedAt: null, importedAt: new Date(), locationKey: "missing", upstreamUrl: "https://files.pythonhosted.org/demo.whl" }), project: "demo-package" };
  await catalog.putArtifact(stored);
  await assert.rejects(service.fetchArtifact({ context, artifactId: stored.artifactId }), { code: "pip_upstream_integrity_failed" });

  const local = fixture();
  const imported = await local.service.importArtifact({ context, artifact: artifact(), bytes });
  await local.content.corrupt(imported.locationKey, Buffer.from("same-length-corrupt!"));
  await assert.rejects(local.service.fetchArtifact({ context, artifactId: imported.artifactId }), { code: "pip_cache_corrupted" });
});

test("package deny, pinned version, and ARM64 compatibility filter the Simple index", async () => {
  const selectedPolicy = policy({ packageRules: [{ pattern: "demo-package", decision: "pin", version: "2.0.0" }] });
  const { service } = fixture({ selectedPolicy });
  await service.importArtifact({ context, artifact: artifact(), bytes });
  assert.equal((await service.listProject({ context, project: "demo-package" })).files.length, 0);
  const denied = fixture({ selectedPolicy: policy({ packageRules: [{ pattern: "demo-*", decision: "deny", version: null }] }) });
  await denied.service.importArtifact({ context, artifact: artifact({ version: "2.0.0", filename: "demo_package-2.0.0.whl" }), bytes });
  assert.equal((await denied.service.listProject({ context, project: "demo-package" })).files.length, 0);
  const wrongArch = fixture();
  await wrongArch.service.importArtifact({ context, artifact: artifact({ architectures: ["amd64"] }), bytes });
  assert.equal((await wrongArch.service.listProject({ context, project: "demo-package" })).files.length, 0);
});

test("offline dependency report traverses verified artifacts and names every missing transitive package", async () => {
  const { service } = fixture({ selectedPolicy: policy({ offlineMode: "require-offline" }) });
  await service.importArtifact({ context, artifact: artifact({ dependencies: [{ project: "Dependency_A", specifier: "==2.0.0" }] }), bytes });
  let report = await service.dependencyAvailability({ context, project: "demo-package", version: "1.0.0" });
  assert.equal(report.complete, false);
  assert.deepEqual(report.missing.map((item) => item.project), ["dependency-a"]);
  await service.importArtifact({ context, artifact: artifact({ project: "dependency-a", version: "2.0.0", filename: "dependency_a-2.0.0.whl", locationKey: "pip/dependency-a/2.0.0", dependencies: [] }), bytes });
  report = await service.dependencyAvailability({ context, project: "demo-package", version: "1.0.0" });
  assert.equal(report.complete, true);
  assert.equal(report.items.length, 2);
});

test("artifact import is administrator-only and rejects an inconsistent digest", async () => {
  const { service } = fixture();
  await assert.rejects(service.importArtifact({ context: { ...context, permissions: [] }, artifact: artifact(), bytes }), { code: "pip_source_permission_required" });
  await assert.rejects(service.importArtifact({ context, artifact: artifact({ sha256: `sha256:${"0".repeat(64)}` }), bytes }), { code: "pip_artifact_checksum_mismatch" });
});
