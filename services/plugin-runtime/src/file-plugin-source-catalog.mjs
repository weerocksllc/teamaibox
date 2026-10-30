import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { bufferedMediaBytes, bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";

const SOURCE_KINDS = new Set(["marketplace", "private-registry", "offline-bundle"]);
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,191}$/;

function fail(message) { throw new TypeError(message); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function exact(value, allowed, required, label) {
  record(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  return value;
}
function decoded(value, label, memory) {
  const maximum = bufferedMediaBytes(memory);
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) + 8) fail(`${label} exceeds available decoding memory`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximum || bytes.toString("base64") !== value) { bytes.fill(0); fail(`${label} is invalid`); }
  return bytes;
}

async function document(path, memory) {
  if (!isAbsolute(path ?? "")) fail("plugin source catalog path must be absolute");
  const facts = await stat(path);
  if (!facts.isFile()) fail("plugin source catalog must be a regular file");
  const bytes = await bufferedMediaResponse({headers:new Headers({'content-length':String(facts.size)}),body:createReadStream(path)}, memory);
  try {
    if (bytes.byteLength < 2) fail("plugin source catalog size is invalid");
    const value = JSON.parse(bytes.toString("utf8"));
    exact(value, new Set(["schemaVersion", "trust", "packages"]), new Set(["schemaVersion", "trust", "packages"]), "catalog");
    if (value.schemaVersion !== 1 || !Array.isArray(value.trust) || !Array.isArray(value.packages)) fail("plugin source catalog schema is invalid");
    return value;
  } finally { bytes.fill(0); }
}

function bundleFrom(entry, memory) {
  const value = exact(entry.bundle, new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]),
    new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]), "package.bundle");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1) fail("package artifacts are invalid");
  const content = new Map();
  const artifacts = value.artifacts.map((item, index) => {
    exact(item, new Set(["descriptor", "contentBase64"]), new Set(["descriptor", "contentBase64"]), `package.artifacts[${index}]`);
    const descriptor = structuredClone(record(item.descriptor, `package.artifacts[${index}].descriptor`));
    if (typeof descriptor.name !== "string" || content.has(descriptor.name)) fail("package artifact identity is invalid");
    content.set(descriptor.name, item.contentBase64);
    return descriptor;
  });
  return Object.freeze({
    packageVersion: value.packageVersion,
    manifest: structuredClone(value.manifest),
    artifacts: Object.freeze(artifacts),
    bundleSignature: structuredClone(value.bundleSignature),
    async openArtifact(name) {
      if (!content.has(name)) throw new Error("plugin artifact not found");
      return decoded(content.get(name), `artifact ${name}`, memory);
    },
    async close() { content.clear(); },
  });
}

export class FilePluginSourceCatalog {
  #path; #memory;
  constructor({ path, memory = {} }) { if (!isAbsolute(path ?? "")) fail("plugin source catalog path must be absolute"); this.#path = path; this.#memory = memory; }

  async resolve(request) {
    if (!SOURCE_KINDS.has(request?.sourceKind) || typeof request.locator !== "string") fail("plugin source request is invalid");
    const value = await document(this.#path, this.#memory);
    const entry = value.packages.find((item) => item?.sourceKind === request.sourceKind && item?.locator === request.locator);
    if (!entry) {
      const error = new Error("plugin source package is unavailable"); error.code = "plugin_source_not_found"; throw error;
    }
    exact(entry, new Set(["sourceKind", "locator", "bundle"]), new Set(["sourceKind", "locator", "bundle"]), "package");
    return bundleFrom(entry, this.#memory);
  }

  async resolveTrust(keyId) {
    if (!KEY_ID.test(keyId ?? "")) return null;
    const value = await document(this.#path, this.#memory);
    const entry = value.trust.find((item) => item?.keyId === keyId);
    if (!entry) return null;
    exact(entry, new Set(["keyId", "publisherId", "status", "publicKeyPem", "validFrom", "validUntil", "pluginIds"]),
      new Set(["keyId", "publisherId", "status", "publicKeyPem"]), "trust");
    if (!KEY_ID.test(entry.keyId) || typeof entry.publisherId !== "string" || entry.status !== "active"
      || typeof entry.publicKeyPem !== "string" || !entry.publicKeyPem.includes("BEGIN PUBLIC KEY")) fail("plugin trust entry is invalid");
    return Object.freeze({ publisherId: entry.publisherId, status: entry.status, publicKey: entry.publicKeyPem,
      validFrom: entry.validFrom ?? null, validUntil: entry.validUntil ?? null,
      ...(entry.pluginIds === undefined ? {} : { pluginIds: Object.freeze([...entry.pluginIds]) }) });
  }
}
