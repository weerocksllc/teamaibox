import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { MemoryNpmCatalog } from "../gateways/npm/src/memory-npm-catalog.mjs";
import { NpmGatewayService, normalizeNpmPackageName } from "../gateways/npm/src/npm-gateway-service.mjs";
import { NpmRegistryHttpApi } from "../gateways/npm/src/npm-registry-http-api.mjs";
import { MemoryPipContentStore } from "../gateways/pip/src/memory-pip-catalog.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b", SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199501";
const bytes = Buffer.from("npm-tarball-content"), integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`, shasum = createHash("sha1").update(bytes).digest("hex");
const context = { identityId: ADMIN, permissions: ["source:manage"], environment: "agent", architecture: "arm64" };
const selectedPolicy = { policyKey: "npm.agent", offlineMode: "require-offline", packageRules: [], sources: [{ sourceId: SOURCE, priority: 1, source: { sourceId: SOURCE, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } }] };
function declaration(overrides = {}) { return { packageName: "@Team/Demo", version: "1.0.0", integrity, sha256, shasum, size: bytes.byteLength, sourceId: SOURCE, sourceKind: "hosted", locationKey: "npm/team/demo/1.0.0", dependencies: {}, optionalDependencies: {}, peerDependencies: {}, engines: { node: ">=18" }, cpu: ["arm64"], os: ["linux"], hasInstallScript: false, signatureStatus: "not-available", scanStatus: "passed", license: "MIT", ...overrides }; }
function fixture(policy = selectedPolicy) { const catalog = new MemoryNpmCatalog(), content = new MemoryPipContentStore(); return { catalog, content, service: new NpmGatewayService({ catalog, content, policyResolver: { resolve: async () => policy }, clock: () => new Date("2026-08-11T08:00:00Z") }) }; }

test("normalizes scoped NPM names and publishes install metadata with local integrity URLs", async () => {
  assert.equal(normalizeNpmPackageName("@Team/Demo"), "@team/demo");
  const { service } = fixture(), imported = await service.importPackage({ context, artifact: declaration(), bytes });
  const api = new NpmRegistryHttpApi({ service });
  const result = await api.handle({ pathname: "/npm/registry/%40team%2Fdemo", context, registryOrigin: "http://npm.internal" });
  const document = JSON.parse(result.body);
  assert.equal(document.name, "@team/demo");
  assert.equal(document.versions["1.0.0"].dist.integrity, integrity);
  assert.match(document.versions["1.0.0"].dist.tarball, new RegExp(imported.artifactId));
  const downloaded = await api.handle({ pathname: `/npm/tarballs/${imported.artifactId}/demo-1.0.0.tgz`, context, registryOrigin: "http://npm.internal" });
  assert.deepEqual(downloaded.body, bytes);
});

test("NPM package policy enforces pins, scopes, ARM64, and checksum integrity", async () => {
  const pinned = fixture({ ...selectedPolicy, packageRules: [{ pattern: "@team/*", decision: "pin", version: "2.0.0" }] });
  await pinned.service.importPackage({ context, artifact: declaration(), bytes });
  await assert.rejects(pinned.service.packageDocument({ context, packageName: "@team/demo", registryOrigin: "http://npm.internal" }), { code: "npm_package_not_found" });
  const architecture = fixture(); await architecture.service.importPackage({ context, artifact: declaration({ cpu: ["x64"] }), bytes });
  await assert.rejects(architecture.service.packageDocument({ context, packageName: "@team/demo", registryOrigin: "http://npm.internal" }), { code: "npm_package_not_found" });
  await assert.rejects(fixture().service.importPackage({ context, artifact: declaration({ integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }), bytes }), { code: "npm_integrity_mismatch" });
});

test("NPM source priority prevents a lower-priority source from replacing the same version", async () => {
  const secondSource = "018f6f18-24d7-7c21-9b62-8c0174199502";
  const selected = { ...selectedPolicy, sources: [
    { sourceId: SOURCE, priority: 20, source: { sourceId: SOURCE, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } },
    { sourceId: secondSource, priority: 10, source: { sourceId: secondSource, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } },
  ] };
  const { service } = fixture(selected);
  await service.importPackage({ context, artifact: declaration(), bytes });
  const preferred = await service.importPackage({ context, artifact: declaration({ sourceId: secondSource, locationKey: "npm/preferred/demo" }), bytes });
  const document = await service.packageDocument({ context, packageName: "@team/demo", registryOrigin: "http://npm.internal" });
  assert.equal(Object.keys(document.versions).length, 1);
  assert.match(document.versions["1.0.0"].dist.tarball, new RegExp(preferred.artifactId));
});

test("NPM fully offline availability resolves semver ranges and reports a missing transitive package", async () => {
  const { service } = fixture();
  await service.importPackage({ context, artifact: declaration({ packageName: "root", dependencies: { dependency: "^2.0.0" }, locationKey: "npm/root" }), bytes });
  let report = await service.dependencyAvailability({ context, packageName: "root", version: "1.0.0" });
  assert.equal(report.complete, false); assert.equal(report.missing[0].packageName, "dependency");
  await service.importPackage({ context, artifact: declaration({ packageName: "dependency", version: "2.3.0", locationKey: "npm/dependency" }), bytes });
  report = await service.dependencyAvailability({ context, packageName: "root", version: "1.0.0" });
  assert.equal(report.complete, true); assert.equal(report.items[1].selectedVersion, "2.3.0");
});
