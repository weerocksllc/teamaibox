import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileBearerTokenProvider,
  HttpsMarketplacePluginSource,
  OciRegistryPluginSource,
  OfflinePluginBundleSource,
  pluginSourceMediaTypes,
} from "../src/real-plugin-sources.mjs";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function packageDocument(bytes, extra = {}) {
  return {
    packageVersion: "teamaibox.plugin-package/v1",
    manifest: { id: "example.notes" },
    artifacts: [{
      descriptor: {
        name: "image-index",
        kind: "oci-image-manifest",
        digest: sha256(bytes),
        sizeBytes: bytes.byteLength,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
      ...extra,
    }],
    bundleSignature: { keyId: "example/release" },
  };
}

test("HTTPS marketplace resolves exact versions, keeps artifacts separate, and authenticates every same-origin request", async () => {
  const artifact = Buffer.from("arm64 image manifest", "utf8");
  const document = packageDocument(artifact, { href: "/v1/artifacts/image-index" });
  const requests = [];
  const source = new HttpsMarketplacePluginSource({
    origin: "https://marketplace.internal/",
    authorizationProvider: { async header() { return "Bearer marketplace-secret"; } },
    async requestBytes(request) {
      requests.push(request);
      return request.url.pathname.endsWith("/bundle")
        ? { bytes: Buffer.from(JSON.stringify(document)), headers: {} }
        : { bytes: artifact, headers: {} };
    },
  });
  const bundle = await source.resolve({ sourceKind: "marketplace", locator: "example.notes@1.2.3" });
  assert.deepEqual(await bundle.openArtifact("image-index"), artifact);
  assert.equal(Object.hasOwn(bundle.artifacts[0], "href"), false);
  assert.deepEqual(requests.map((item) => item.url.pathname), [
    "/v1/plugins/example.notes/versions/1.2.3/bundle",
    "/v1/artifacts/image-index",
  ]);
  assert.ok(requests.every((item) => item.authorization === "Bearer marketplace-secret"));
  await bundle.close();
  await assert.rejects(bundle.openArtifact("image-index"), (error) => error.code === "plugin_source_not_found");
});

test("HTTPS marketplace rejects redirects by construction and rejects cross-origin artifact locations", async () => {
  const artifact = Buffer.from("artifact", "utf8");
  const document = packageDocument(artifact, { href: "https://attacker.invalid/artifact" });
  const source = new HttpsMarketplacePluginSource({
    origin: "https://marketplace.internal/",
    async requestBytes() { return { bytes: Buffer.from(JSON.stringify(document)), headers: {} }; },
  });
  await assert.rejects(source.resolve({ sourceKind: "marketplace", locator: "example.notes@1.2.3" }), /escapes/);
  await assert.rejects(source.resolve({ sourceKind: "marketplace", locator: "example.notes:latest" }), /locator/);
});

test("private OCI registry requires an allowlisted digest reference and verifies manifest, config, and layer digests", async () => {
  const artifact = Buffer.from("arm64 artifact", "utf8");
  const descriptor = packageDocument(artifact).artifacts[0].descriptor;
  const config = Buffer.from(JSON.stringify({
    packageVersion: "teamaibox.plugin-package/v1",
    manifest: { id: "example.notes" },
    artifacts: [descriptor],
    bundleSignature: { keyId: "example/release" },
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: pluginSourceMediaTypes.ociManifest,
    artifactType: pluginSourceMediaTypes.package,
    config: { mediaType: pluginSourceMediaTypes.package, digest: sha256(config), size: config.byteLength },
    layers: [{
      mediaType: descriptor.mediaType,
      digest: descriptor.digest,
      size: descriptor.sizeBytes,
      annotations: { "org.opencontainers.image.title": descriptor.name },
    }],
  }));
  const manifestDigest = sha256(manifest);
  const requests = [];
  const source = new OciRegistryPluginSource({
    origin: "https://registry.internal/",
    allowedReferenceHosts: ["registry.internal"],
    authorizationProvider: { async header() { return "Bearer registry-secret"; } },
    async requestBytes(request) {
      requests.push(request);
      if (request.url.pathname.includes("/manifests/")) return { bytes: manifest, headers: { "docker-content-digest": manifestDigest } };
      if (request.url.pathname.endsWith(sha256(config))) return { bytes: config, headers: {} };
      if (request.url.pathname.endsWith(descriptor.digest)) return { bytes: artifact, headers: {} };
      throw new Error("unexpected registry path");
    },
  });
  const bundle = await source.resolve({ sourceKind: "private-registry", locator: `registry.internal/team/notes@${manifestDigest}` });
  assert.deepEqual(await bundle.openArtifact(descriptor.name), artifact);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((item) => item.authorization === "Bearer registry-secret"));
  await assert.rejects(source.resolve({ sourceKind: "private-registry", locator: "registry.internal/team/notes:latest" }), /not allowed/);
  await assert.rejects(source.resolve({ sourceKind: "private-registry", locator: `other.internal/team/notes@${manifestDigest}` }), /not allowed/);
});

test("private OCI registry rejects registry digest drift before package parsing", async () => {
  const claimed = `sha256:${"a".repeat(64)}`;
  const source = new OciRegistryPluginSource({
    origin: "https://registry.internal/",
    allowedReferenceHosts: ["registry.internal"],
    authorizationProvider: { async header() { return "Bearer registry-secret"; } },
    async requestBytes() { return { bytes: Buffer.from("{}"), headers: {} }; },
  });
  await assert.rejects(source.resolve({ sourceKind: "private-registry", locator: `registry.internal/team/notes@${claimed}` }), /digest/);
});

test("offline bundle source reads bounded regular files and denies traversal and symbolic links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-offline-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleRoot = join(root, "upload-001");
  await mkdir(bundleRoot);
  const artifact = Buffer.from("offline arm64 artifact", "utf8");
  await writeFile(join(bundleRoot, "artifact.bin"), artifact);
  await writeFile(join(bundleRoot, "bundle.json"), JSON.stringify(packageDocument(artifact, { path: "artifact.bin" })));
  const source = new OfflinePluginBundleSource({ root });
  const bundle = await source.resolve({ sourceKind: "offline-bundle", locator: "upload-001" });
  assert.deepEqual(await bundle.openArtifact("image-index"), artifact);
  await assert.rejects(source.resolve({ sourceKind: "offline-bundle", locator: "../upload-001" }), /invalid/);

  await symlink("artifact.bin", join(bundleRoot, "linked.bin"));
  await writeFile(join(bundleRoot, "bundle.json"), JSON.stringify(packageDocument(artifact, { path: "linked.bin" })));
  const linked = await source.resolve({ sourceKind: "offline-bundle", locator: "upload-001" });
  await assert.rejects(linked.openArtifact("image-index"), /symbolic link/);
});

test("file bearer provider loads a token at request time without placing it in source configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-plugin-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "token");
  await writeFile(path, "first-token-value-1234\n", { mode: 0o600 });
  const provider = new FileBearerTokenProvider({ path });
  assert.equal(await provider.header(), "Bearer first-token-value-1234");
  await writeFile(path, "rotated-token-value-5678\n", { mode: 0o600 });
  assert.equal(await provider.header(), "Bearer rotated-token-value-5678");
  assert.throws(() => new FileBearerTokenProvider({ path: "relative-token" }), /absolute/);
});
