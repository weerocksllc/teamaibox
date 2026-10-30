import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { bufferedMediaBytes, bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,255}$/;
const MARKETPLACE_LOCATOR = /^([a-z][a-z0-9.-]{2,127})@([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)$/;
const OCI_REFERENCE = /^([a-z0-9.-]+(?::[0-9]+)?)\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)@(sha256:[a-f0-9]{64})$/;
const PACKAGE_MEDIA_TYPE = "application/vnd.teamaibox.plugin.package.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

function fail(message, code = "plugin_source_invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exact(value, allowed, required, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  return value;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactDescriptor(value, label) {
  const descriptor = structuredClone(object(value, label));
  if (typeof descriptor.name !== "string" || !SAFE_ID.test(descriptor.name)
    || !SHA256.test(descriptor.digest ?? "")
    || !Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 1
    || descriptor.sizeBytes >= Number.MAX_SAFE_INTEGER
    || typeof descriptor.mediaType !== "string" || descriptor.mediaType.length < 3 || descriptor.mediaType.length > 255) {
    fail(`${label} is invalid`);
  }
  return descriptor;
}

function boundedJson(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > bufferedMediaBytes()) fail(`${label} exceeds available parsing memory`);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { fail(`${label} is not valid JSON`); }
}

function endpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(`${label} must be an HTTPS origin`);
  return url;
}

function responseBytes(result, maximumBytes, label) {
  const bytes = result?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) fail(`${label} response is invalid`, "plugin_source_response_invalid");
  return Buffer.from(bytes);
}

function sameOriginUrl(origin, href, label) {
  let url;
  try { url = new URL(href, origin); } catch { fail(`${label} URL is invalid`); }
  if (url.origin !== origin.origin || url.protocol !== "https:" || url.username || url.password || url.hash) fail(`${label} URL escapes the configured origin`);
  return url;
}

function remoteBundle(document, openArtifact) {
  exact(document, new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]),
    new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]), "plugin package");
  if (!Array.isArray(document.artifacts) || document.artifacts.length < 1) fail("plugin package artifacts are invalid");
  const descriptors = [];
  const names = new Set();
  for (let index = 0; index < document.artifacts.length; index += 1) {
    const descriptor = artifactDescriptor(document.artifacts[index], `plugin package artifacts[${index}]`);
    if (names.has(descriptor.name)) fail("plugin package artifact name is invalid");
    names.add(descriptor.name);
    descriptors.push(descriptor);
  }
  let closed = false;
  return Object.freeze({
    packageVersion: document.packageVersion,
    manifest: structuredClone(document.manifest),
    artifacts: Object.freeze(descriptors),
    bundleSignature: structuredClone(document.bundleSignature),
    async openArtifact(name) {
      if (closed || !names.has(name)) fail("plugin artifact is unavailable", "plugin_source_not_found");
      return openArtifact(name);
    },
    async close() { closed = true; names.clear(); },
  });
}

export async function httpsRequestBytes({ url, accept, authorization = null, ca = null, certificate = null, privateKey = null,
  maximumBytes = bufferedMediaBytes(), timeoutMilliseconds = 30_000 }) {
  if (!(url instanceof URL) || url.protocol !== "https:" || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) fail("HTTPS source request is invalid");
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = { accept, "user-agent": "teamaibox-plugin-source/1" };
    if (authorization) headers.authorization = authorization;
    const request = httpsRequest(url, {
      method: "GET", headers, ca: ca ?? undefined, cert: certificate ?? undefined, key: privateKey ?? undefined,
      servername: url.hostname, timeout: timeoutMilliseconds, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    }, async (response) => {
      let total = 0;
      try {
        if (response.statusCode !== 200) {
          const error = new Error(response.statusCode === 404 ? "plugin source package is unavailable" : "plugin source request failed");
          error.code = response.statusCode === 404 ? "plugin_source_not_found" : "plugin_source_unavailable";
          response.destroy(); rejectPromise(error);
          return;
        }
        const body = (async function* () { for await (const chunk of response) {
          total += chunk.length;
          if (total > maximumBytes) throw new Error("plugin source response exceeds its declared size");
          yield chunk;
        } })();
        const headers = new Headers(response.headers['content-length'] ? {'content-length':response.headers['content-length']} : {});
        const bytes = await bufferedMediaResponse({headers,body});
        resolvePromise({ bytes, headers: Object.freeze({ ...response.headers }) });
      } catch (error) { response.destroy(); rejectPromise(error); }
    });
    request.once("timeout", () => request.destroy(new Error("plugin source request timed out")));
    request.once("error", (error) => {
      if (!error.code?.startsWith("plugin_source_")) error.code = "plugin_source_unavailable";
      rejectPromise(error);
    });
    request.end();
  });
}

export class FileBearerTokenProvider {
  #path;
  constructor({ path }) {
    if (!isAbsolute(path ?? "")) fail("plugin source token path must be absolute");
    this.#path = path;
  }
  async header() {
    const bytes = await readFile(this.#path);
    try {
      if (bytes.byteLength < 16 || bytes.byteLength > 4096) fail("plugin source token is invalid");
      const token = bytes.toString("utf8").trim();
      if (!/^[A-Za-z0-9._~+/-]{16,4095}$/.test(token)) fail("plugin source token is invalid");
      return `Bearer ${token}`;
    } finally { bytes.fill(0); }
  }
}

export class HttpsMarketplacePluginSource {
  #origin; #authorization; #requestBytes; #ca;
  constructor({ origin, authorizationProvider = null, requestBytes = httpsRequestBytes, ca = null }) {
    this.#origin = endpoint(origin, "marketplace origin");
    if (authorizationProvider !== null && typeof authorizationProvider?.header !== "function") fail("marketplace authorization provider is invalid");
    if (typeof requestBytes !== "function") fail("marketplace request transport is invalid");
    this.#authorization = authorizationProvider; this.#requestBytes = requestBytes;
    this.#ca = ca === null ? null : Buffer.from(ca);
  }
  async #get(url, accept, maximumBytes) {
    return this.#requestBytes({ url, accept, maximumBytes, ca: this.#ca,
      authorization: this.#authorization ? await this.#authorization.header() : null });
  }
  async resolve(request) {
    if (request?.sourceKind !== "marketplace") fail("marketplace source request is invalid");
    const match = MARKETPLACE_LOCATOR.exec(request.locator ?? "");
    if (!match) fail("marketplace locator is invalid");
    const url = sameOriginUrl(this.#origin, `/v1/plugins/${encodeURIComponent(match[1])}/versions/${encodeURIComponent(match[2])}/bundle`, "marketplace bundle");
    const maximum = bufferedMediaBytes();
    const result = await this.#get(url, "application/vnd.teamaibox.plugin.package.v1+json", maximum);
    const document = boundedJson(responseBytes(result, maximum, "marketplace bundle"), "marketplace bundle");
    exact(document, new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]),
      new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]), "marketplace bundle");
    const locations = new Map();
    const descriptors = document.artifacts.map((item, index) => {
      exact(item, new Set(["descriptor", "href"]), new Set(["descriptor", "href"]), `marketplace artifacts[${index}]`);
      const descriptor = artifactDescriptor(item.descriptor, `marketplace artifacts[${index}].descriptor`);
      if (locations.has(descriptor.name)) fail("marketplace artifact name is invalid");
      locations.set(descriptor.name, sameOriginUrl(this.#origin, item.href, `marketplace artifact ${descriptor.name}`));
      return descriptor;
    });
    return remoteBundle({ ...document, artifacts: descriptors }, async (name) => {
      const descriptor = descriptors.find((item) => item.name === name);
      const maximum = descriptor.sizeBytes + 1;
      const artifact = await this.#get(locations.get(name), descriptor.mediaType, maximum);
      return responseBytes(artifact, maximum, `marketplace artifact ${name}`);
    });
  }
  close() { this.#ca?.fill(0); this.#ca = null; }
}

export class OciRegistryPluginSource {
  #origin; #authorization; #requestBytes; #ca; #allowedHosts;
  constructor({ origin, allowedReferenceHosts, authorizationProvider, requestBytes = httpsRequestBytes, ca = null }) {
    this.#origin = endpoint(origin, "OCI registry origin");
    if (!Array.isArray(allowedReferenceHosts) || !allowedReferenceHosts.length
      || allowedReferenceHosts.some((item) => typeof item !== "string" || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(item))) fail("OCI reference host allowlist is invalid");
    if (typeof authorizationProvider?.header !== "function" || typeof requestBytes !== "function") fail("OCI registry authorization or transport is invalid");
    this.#allowedHosts = new Set(allowedReferenceHosts); this.#authorization = authorizationProvider;
    this.#requestBytes = requestBytes; this.#ca = ca === null ? null : Buffer.from(ca);
  }
  async #get(path, accept, maximumBytes) {
    const url = sameOriginUrl(this.#origin, path, "OCI registry");
    return this.#requestBytes({ url, accept, maximumBytes, ca: this.#ca, authorization: await this.#authorization.header() });
  }
  async resolve(request) {
    if (request?.sourceKind !== "private-registry") fail("private registry source request is invalid");
    const match = OCI_REFERENCE.exec(request.locator ?? "");
    if (!match || !this.#allowedHosts.has(match[1])) fail("private registry reference is not allowed");
    const repository = match[2], manifestDigest = match[3];
    const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
    const maximum = bufferedMediaBytes();
    const manifestResult = await this.#get(`/v2/${encodedRepository}/manifests/${manifestDigest}`, OCI_MANIFEST_MEDIA_TYPE, maximum);
    const manifestBytes = responseBytes(manifestResult, maximum, "OCI package manifest");
    if (digest(manifestBytes) !== manifestDigest) fail("OCI package manifest digest is invalid");
    const responseDigest = manifestResult.headers?.["docker-content-digest"];
    if (responseDigest !== undefined && responseDigest !== manifestDigest) fail("OCI registry content digest header is invalid");
    const manifest = boundedJson(manifestBytes, "OCI package manifest");
    exact(manifest, new Set(["schemaVersion", "mediaType", "artifactType", "config", "layers", "annotations"]),
      new Set(["schemaVersion", "mediaType", "artifactType", "config", "layers"]), "OCI package manifest");
    if (manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE || manifest.artifactType !== PACKAGE_MEDIA_TYPE
      || !Array.isArray(manifest.layers)) fail("OCI package manifest media type is invalid");
    const config = exact(manifest.config, new Set(["mediaType", "digest", "size"]), new Set(["mediaType", "digest", "size"]), "OCI package config");
    if (config.mediaType !== PACKAGE_MEDIA_TYPE || !SHA256.test(config.digest) || !Number.isSafeInteger(config.size) || config.size < 2 || config.size >= Number.MAX_SAFE_INTEGER) fail("OCI package config descriptor is invalid");
    const configResult = await this.#get(`/v2/${encodedRepository}/blobs/${config.digest}`, PACKAGE_MEDIA_TYPE, config.size + 1);
    const configBytes = responseBytes(configResult, config.size + 1, "OCI package config");
    if (configBytes.byteLength !== config.size || digest(configBytes) !== config.digest) fail("OCI package config blob is invalid");
    const document = boundedJson(configBytes, "OCI package config");
    const layerByName = new Map();
    for (let index = 0; index < manifest.layers.length; index += 1) {
      const layer = exact(manifest.layers[index], new Set(["mediaType", "digest", "size", "annotations"]),
        new Set(["mediaType", "digest", "size", "annotations"]), `OCI package layers[${index}]`);
      const name = layer.annotations?.["org.opencontainers.image.title"];
      if (typeof name !== "string" || !SAFE_ID.test(name) || layerByName.has(name) || !SHA256.test(layer.digest)
        || !Number.isSafeInteger(layer.size) || layer.size < 1 || layer.size >= Number.MAX_SAFE_INTEGER) fail("OCI package layer descriptor is invalid");
      layerByName.set(name, layer);
    }
    const descriptors = document.artifacts;
    if (!Array.isArray(descriptors) || descriptors.length !== layerByName.size) fail("OCI package artifact coverage is invalid");
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = artifactDescriptor(descriptors[index], `OCI package artifacts[${index}]`);
      descriptors[index] = descriptor;
      const layer = layerByName.get(descriptor.name);
      if (!layer || layer.digest !== descriptor.digest || layer.size !== descriptor.sizeBytes || layer.mediaType !== descriptor.mediaType) fail("OCI package layer differs from its signed artifact descriptor");
    }
    return remoteBundle(document, async (name) => {
      const layer = layerByName.get(name);
      const artifact = await this.#get(`/v2/${encodedRepository}/blobs/${layer.digest}`, layer.mediaType, layer.size + 1);
      return responseBytes(artifact, layer.size + 1, `OCI artifact ${name}`);
    });
  }
  close() { this.#ca?.fill(0); this.#ca = null; }
}

async function safeFile(root, path, maximumBytes, label) {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, path);
  const within = relative(rootReal, candidate);
  if (!within || within.startsWith(".." + sep) || within === ".." || isAbsolute(within)) fail(`${label} path escapes the offline root`);
  let current = rootReal;
  for (const component of within.split(sep)) {
    current = resolve(current, component);
    const componentFacts = await lstat(current);
    if (componentFacts.isSymbolicLink()) fail(`${label} traverses a symbolic link`);
  }
  const facts = await lstat(candidate);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.size < 1 || facts.size > maximumBytes) fail(`${label} is not a bounded regular file`);
  const actual = await realpath(candidate);
  const actualRelative = relative(rootReal, actual);
  if (!actualRelative || actualRelative.startsWith(".." + sep) || actualRelative === ".." || isAbsolute(actualRelative)) fail(`${label} resolves outside the offline root`);
  const bytes = await bufferedMediaResponse({
    headers: new Headers({ "content-length": String(facts.size) }),
    body: createReadStream(actual),
  });
  if (bytes.byteLength !== facts.size) { bytes.fill(0); fail(`${label} changed while reading`); }
  return bytes;
}

export class OfflinePluginBundleSource {
  #root;
  constructor({ root }) {
    if (!isAbsolute(root ?? "")) fail("offline plugin root must be absolute");
    this.#root = root;
  }
  async resolve(request) {
    if (request?.sourceKind !== "offline-bundle" || !SAFE_ID.test(request.locator ?? "")
      || request.locator.split("/").some((item) => item === "." || item === "..")) fail("offline bundle request is invalid");
    const indexBytes = await safeFile(this.#root, `${request.locator}/bundle.json`, bufferedMediaBytes(), "offline bundle index");
    let document;
    try { document = boundedJson(indexBytes, "offline bundle index"); } finally { indexBytes.fill(0); }
    exact(document, new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]),
      new Set(["packageVersion", "manifest", "artifacts", "bundleSignature"]), "offline bundle");
    const paths = new Map();
    const descriptors = document.artifacts.map((item, index) => {
      exact(item, new Set(["descriptor", "path"]), new Set(["descriptor", "path"]), `offline artifacts[${index}]`);
      const descriptor = artifactDescriptor(item.descriptor, `offline artifacts[${index}].descriptor`);
      if (paths.has(descriptor.name) || typeof item.path !== "string"
        || !SAFE_ID.test(item.path) || item.path.split("/").some((part) => part === "." || part === "..")) fail("offline artifact path is invalid");
      paths.set(descriptor.name, `${request.locator}/${item.path}`);
      return descriptor;
    });
    return remoteBundle({ ...document, artifacts: descriptors }, async (name) => {
      const descriptor = descriptors.find((item) => item.name === name);
      return safeFile(this.#root, paths.get(name), descriptor.sizeBytes + 1, `offline artifact ${name}`);
    });
  }
}

export const pluginSourceMediaTypes = Object.freeze({ package: PACKAGE_MEDIA_TYPE, ociManifest: OCI_MANIFEST_MEDIA_TYPE });
