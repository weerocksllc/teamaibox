import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";

const FINGERPRINT = /^[A-F0-9]{64}$/;
const KEYRING = /^\/run\/teamaibox\/source-keys\/[A-Za-z0-9._-]+\.json$/;
const MEDIA_ROOT = /^\/run\/teamaibox\/offline-media\/[0-9a-f-]{36}$/i;
async function regular(path) {
  const resolved = await realpath(path);
  if (resolved !== path) throw new Error("Offline media signature input cannot be a symbolic link");
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    throw new Error("Offline media signature input is not a regular file");
  }
  return bufferedMediaResponse(new Response(Readable.toWeb(createReadStream(resolved)), { headers: { 'content-length': String(stats.size) } }));
}

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function publicKeys(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new TypeError("Offline media trusted keyring is invalid"); }
  exactObject(value, ["schemaVersion", "keys"], "Offline media trusted keyring");
  if (value.schemaVersion !== 1 || !Array.isArray(value.keys) || value.keys.length < 1) {
    throw new TypeError("Offline media trusted keyring is invalid");
  }
  const result = new Map();
  for (const entry of value.keys) {
    exactObject(entry, ["fingerprint", "publicKeyPem"], "Offline media trusted key");
    if (!FINGERPRINT.test(entry.fingerprint ?? "") || typeof entry.publicKeyPem !== "string") {
      throw new TypeError("Offline media trusted key is invalid");
    }
    const key = createPublicKey(entry.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Offline media trusted key must be Ed25519");
    const actual = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
    if (actual !== entry.fingerprint || result.has(actual)) throw new TypeError("Offline media trusted key fingerprint is invalid");
    result.set(actual, key);
  }
  return result;
}

export class OfflineMediaEd25519Verifier {
  #keyring; #allowTestRoot;
  constructor({ trustedKeyringFile = "/run/teamaibox/source-keys/offline-media.ed25519.json", allowTestRoot = false } = {}) {
    if ((!allowTestRoot && !KEYRING.test(trustedKeyringFile)) || !pathIsAbsolute(trustedKeyringFile)) throw new TypeError("Offline media Ed25519 keyring path is invalid");
    this.#keyring = trustedKeyringFile;
    this.#allowTestRoot = allowTestRoot;
  }

  async verifyFiles({ payloadPath, signaturePath, expectedFingerprint, allowedRoot }) {
    if ((!this.#allowTestRoot && !MEDIA_ROOT.test(allowedRoot)) || !pathIsAbsolute(allowedRoot) || !FINGERPRINT.test(expectedFingerprint ?? "")
        || !payloadPath.startsWith(`${allowedRoot}/`) || !signaturePath.startsWith(`${allowedRoot}/`)) {
      throw new TypeError("Offline media Ed25519 verification input is invalid");
    }
    const [keyringBytes, payload, signatureBytes] = await Promise.all([
      regular(this.#keyring),
      regular(payloadPath),
      regular(signaturePath),
    ]);
    const keys = publicKeys(keyringBytes);
    let declaration;
    try { declaration = JSON.parse(signatureBytes.toString("utf8")); } catch { declaration = null; }
    exactObject(declaration, ["schemaVersion", "keyFingerprint", "signatureBase64"], "Offline media detached signature");
    if (declaration.schemaVersion !== 1 || declaration.keyFingerprint !== expectedFingerprint
        || typeof declaration.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(declaration.signatureBase64)) {
      return Object.freeze({ valid: false, fingerprint: declaration?.keyFingerprint ?? null });
    }
    const key = keys.get(expectedFingerprint);
    if (!key) return Object.freeze({ valid: false, fingerprint: expectedFingerprint });
    const signature = Buffer.from(declaration.signatureBase64, "base64");
    return Object.freeze({ valid: signature.byteLength === 64 && verify(null, payload, key, signature), fingerprint: expectedFingerprint });
  }
}

function pathIsAbsolute(value) { return typeof value === "string" && value.startsWith("/") && !value.includes("\0") && !value.split("/").includes(".."); }
