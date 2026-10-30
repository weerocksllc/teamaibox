import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PipJsonUpstreamAdapter } from "../gateways/pip/src/pip-json-upstream-adapter.mjs";

const SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const wheel = Buffer.from("wheel-content");
const wheelDigest = createHash("sha256").update(wheel).digest("hex");
const metadata = Buffer.from("Metadata-Version: 2.4\nName: demo-package\nVersion: 1.0.0\nLicense-Expression: MIT\nRequires-Dist: dependency-a==2.0.0\nRequires-Dist: docs; extra == 'docs'\n");
const metadataDigest = createHash("sha256").update(metadata).digest("hex");
const source = { sourceId: SOURCE, endpoint: { url: "https://pypi.example/simple/" }, credentialSecretKey: "source.pip.private" };

test("JSON upstream adapter verifies PEP 691 declarations and PEP 658 metadata without exposing credentials", async () => {
  const requests = [], authorization = [];
  const fetchImplementation = async (url, options) => {
    requests.push(String(url)); authorization.push(options.headers.authorization);
    if (String(url).endsWith(".metadata")) return new Response(metadata, { status: 200, headers: { "content-length": String(metadata.byteLength) } });
    if (String(url).includes("/simple/demo-package/")) return new Response(JSON.stringify({ meta: { "api-version": "1.4" }, name: "demo-package", files: [{ filename: "demo_package-1.0.0-py3-none-any.whl", url: "https://files.example/packages/demo.whl", hashes: { sha256: wheelDigest }, size: wheel.byteLength, "requires-python": ">=3.11", "core-metadata": { sha256: metadataDigest } }] }), { status: 200, headers: { "content-type": "application/vnd.pypi.simple.v1+json" } });
    return new Response(wheel, { status: 200, headers: { "content-length": String(wheel.byteLength) } });
  };
  const adapter = new PipJsonUpstreamAdapter({
    fetchImplementation,
    authorizationProvider: { headersFor: async ({ secretKey }) => { assert.equal(secretKey, "source.pip.private"); return { authorization: "Bearer protected-value" }; } },
    inspector: { inspect: async ({ metadata: facts }) => ({ scanStatus: "passed", signatureStatus: "not-available", license: facts.license }) },
    allowedArtifactOrigins: ["https://files.example"],
  });
  const artifacts = await adapter.listProject({ source, project: "demo-package" });
  assert.equal(artifacts[0].version, "1.0.0");
  assert.equal(artifacts[0].architectures[0], "all");
  assert.deepEqual(artifacts[0].dependencies, [{ project: "dependency-a", specifier: "==2.0.0", marker: null, optional: false }, { project: "docs", specifier: null, marker: "extra == 'docs'", optional: true }]);
  assert.equal(artifacts[0].license, "MIT");
  assert.equal(artifacts[0].upstreamUrl, "https://files.example/packages/demo.whl");
  assert.deepEqual(await adapter.fetchArtifact({ source, artifact: artifacts[0] }), new Uint8Array(wheel));
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(authorization), new Set(["Bearer protected-value"]));
  assert.equal(JSON.stringify(artifacts).includes("protected-value"), false);
});

test("JSON upstream adapter rejects unapproved artifact origins and core metadata drift", async () => {
  const document = (url, digest = metadataDigest) => new Response(JSON.stringify({ meta: { "api-version": "1.4" }, files: [{ filename: "demo_package-1.0.0-py3-none-any.whl", url, hashes: { sha256: wheelDigest }, size: wheel.byteLength, "core-metadata": { sha256: digest } }] }), { status: 200, headers: { "content-type": "application/vnd.pypi.simple.v1+json" } });
  const adapter = new PipJsonUpstreamAdapter({ fetchImplementation: async () => document("https://evil.example/demo.whl"), inspector: { inspect: async () => ({ scanStatus: "passed", signatureStatus: "not-available" }) } });
  await assert.rejects(adapter.listProject({ source, project: "demo-package" }), { code: "pip_upstream_invalid" });
  let calls = 0;
  const drift = new PipJsonUpstreamAdapter({ fetchImplementation: async () => ++calls === 1 ? document("https://pypi.example/packages/demo.whl", "0".repeat(64)) : new Response(metadata, { status: 200 }), inspector: { inspect: async () => ({ scanStatus: "passed", signatureStatus: "not-available" }) } });
  await assert.rejects(drift.listProject({ source, project: "demo-package" }), { code: "pip_upstream_invalid" });
});
