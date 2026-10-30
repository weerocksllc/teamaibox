import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@+._/-]{1,512}$/;
const ROOT = /^\/run\/teamaibox\/offline-media$/;

async function regularFile(root, relativePath) {
  if (!RELATIVE.test(relativePath)) throw new TypeError("Offline media path is invalid");
  const candidate = path.join(root, relativePath);
  const resolved = await realpath(candidate);
  if (resolved !== candidate || !resolved.startsWith(`${root}/`)) throw new Error("Offline media symbolic links are forbidden");
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Offline media entry is not a regular file");
  return { path: resolved, size: stats.size };
}

async function fileDigest(filename) {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(filename, { flags: "r" })) { hash.update(chunk); size += chunk.length; }
  return { sha256: `sha256:${hash.digest("hex")}`, size };
}

export class MountedOfflineMediaAdapter {
  #inventory; #signatureVerifier; #root; #handles = new Map();
  constructor({ inventory, signatureVerifier, root = "/run/teamaibox/offline-media", allowTestRoot = false }) {
    if (typeof inventory?.listReadOnlyMedia !== "function" || typeof signatureVerifier?.verifyFiles !== "function"
      || (!allowTestRoot && !ROOT.test(root)) || !path.isAbsolute(root)) throw new TypeError("Mounted offline media adapter configuration is invalid");
    this.#inventory = inventory; this.#signatureVerifier = signatureVerifier; this.#root = path.normalize(root);
  }

  async listAttached({ nodeId }) {
    if (!UUID.test(nodeId ?? "")) throw new TypeError("Offline media node identity is invalid");
    const values = await this.#inventory.listReadOnlyMedia({ nodeId });
    if (!Array.isArray(values)) throw new TypeError("Offline media inventory response is invalid");
    const output = [];
    this.#handles.clear();
    for (const value of values) {
      if (!UUID.test(value?.mountId ?? "") || !UUID.test(value?.filesystemUuid ?? "") || value.readOnly !== true || value.mountMode !== "read-only"
        || !SHA256.test(value.deviceIdentitySha256 ?? "")) throw new TypeError("Offline media inventory evidence is invalid");
      const mountRoot = path.join(this.#root, value.mountId);
      const resolvedRoot = await realpath(mountRoot);
      if (resolvedRoot !== mountRoot || !resolvedRoot.startsWith(`${this.#root}/`) || !(await lstat(resolvedRoot)).isDirectory()) throw new Error("Offline media mount is not a direct read-only inventory root");
      const manifest = await regularFile(resolvedRoot, "manifest.json");
      const manifestDigest = await fileDigest(manifest.path);
      const mediaHandle = `offline-media.${nodeId}.${value.mountId}`;
      this.#handles.set(mediaHandle, resolvedRoot);
      output.push({ ...structuredClone(value), present: true, mediaHandle, manifestSha256: manifestDigest.sha256 });
    }
    return output;
  }

  #rootFor(mediaHandle) { const root = this.#handles.get(mediaHandle); if (!root) throw new Error("Offline media handle is stale or unknown"); return root; }

  async readManifest({ mediaHandle }) {
    const file = await regularFile(this.#rootFor(mediaHandle), "manifest.json");
    return bufferedMediaResponse(new Response(Readable.toWeb(createReadStream(file.path)), { headers: { 'content-length': String(file.size) } }));
  }

  async verifyManifest({ mediaHandle, manifestBytes, detachedSignaturePath, expectedKeyFingerprint }) {
    const root = this.#rootFor(mediaHandle); const payload = await regularFile(root, "manifest.json"); const signature = await regularFile(root, detachedSignaturePath);
    const actual = await fileDigest(payload.path); const supplied = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
    if (actual.sha256 !== supplied) return { status: "invalid", keyFingerprint: null, signedSha256: actual.sha256 };
    const result = await this.#signatureVerifier.verifyFiles({ payloadPath: payload.path, signaturePath: signature.path, expectedFingerprint: expectedKeyFingerprint, allowedRoot: root });
    return { status: result.valid ? "verified" : "invalid", keyFingerprint: result.fingerprint, signedSha256: actual.sha256 };
  }

  async verifyArtifact({ mediaHandle, relativePath, expectedSha256, expectedBytes, detachedSignaturePath, expectedKeyFingerprint }) {
    const root = this.#rootFor(mediaHandle); const payload = await regularFile(root, relativePath); const actual = await fileDigest(payload.path);
    let signatureStatus = "manifest-covered", keyFingerprint = null;
    if (detachedSignaturePath !== null) {
      const signature = await regularFile(root, detachedSignaturePath);
      const result = await this.#signatureVerifier.verifyFiles({ payloadPath: payload.path, signaturePath: signature.path, expectedFingerprint: expectedKeyFingerprint, allowedRoot: root });
      signatureStatus = result.valid ? "verified" : "invalid"; keyFingerprint = result.fingerprint;
    }
    return { actualSha256: actual.sha256, actualBytes: actual.size, integrity: actual.sha256 === expectedSha256 && actual.size === expectedBytes ? "verified" : "invalid", signatureStatus, keyFingerprint };
  }
}
