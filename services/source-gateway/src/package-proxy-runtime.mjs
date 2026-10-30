import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open, readFile, rename, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";
const MAX_REDIRECTS = 4;
const DEFAULT_UPSTREAM_ATTEMPT_TIMEOUT_MILLISECONDS = 90_000;
const DEFAULT_UPSTREAM_RETRY_DELAYS_MILLISECONDS = Object.freeze([250, 1_000]);
const PROJECT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,188}[A-Za-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;

const UPSTREAMS = Object.freeze({
  pipIndex: new URL("https://pypi.org/simple/"),
  npmRegistry: new URL("https://registry.npmjs.org/"),
  aptRepository: new URL("https://repo.huaweicloud.com/debian/"),
});

const ALLOWED_HOSTS = Object.freeze({
  pip: new Set(["pypi.org", "files.pythonhosted.org"]),
  npm: new Set(["registry.npmjs.org"]),
  apt: new Set(["repo.huaweicloud.com"]),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeCacheRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.includes("\0")
    || value.split("/").includes("..")) throw new TypeError("Package cache root is invalid");
  return value.replace(/\/+$/, "");
}

function json(response, status, value, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(bytes);
}

function decodeTarget(value, ecosystem) {
  let decoded;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); } catch { throw new Error("package_target_invalid"); }
  let target;
  try { target = new URL(decoded); } catch { throw new Error("package_target_invalid"); }
  if (target.protocol !== "https:" || target.username || target.password || target.hash
    || !ALLOWED_HOSTS[ecosystem].has(target.hostname)) {
    throw new Error("package_target_denied");
  }
  return target;
}

function encodeTarget(value) {
  return Buffer.from(value.href).toString("base64url");
}

async function hashFile(path) {
  const hash=createHash("sha256");let size=0;
  for await(const bytes of createReadStream(path)){hash.update(bytes);size+=bytes.length}
  return {size,sha256:hash.digest("hex")};
}

async function downloadFile(response,path,{signal,progress,availableDisk}) {
  const temporary=path+"."+randomBytes(8).toString("hex")+".next";
  let file;const hash=createHash("sha256");let size=0,remaining=0;
  try{
    file=await open(temporary,"wx",0o600);
    // Fetch decompresses gzip/br bodies but leaves their wire headers intact.
    // A compressed Content-Length is not the number of bytes written to disk.
    const encoding=response.headers.get("content-encoding");
    const declared=Number(encoding&&encoding!=="identity"?0:response.headers.get("content-length")??0);
    if(!Number.isSafeInteger(declared)||declared<0)throw new Error("upstream_content_length_invalid");
    const disk=async()=>{const bytes=await availableDisk();if(!Number.isFinite(bytes)||bytes<0)throw Object.assign(new Error("package_cache_storage_unavailable"),{status:507});return bytes};
    remaining=await disk();
    if(declared>remaining)throw Object.assign(new Error("package_cache_storage_unavailable"),{status:507});
    let probeBytes=0;
    for await(const chunk of response.body??[]){
      signal.throwIfAborted();progress();
      const bytes=Buffer.from(chunk);
      if(probeBytes>=16*1024*1024 || bytes.length>remaining){remaining=await disk();probeBytes=0}
      if(bytes.length>remaining)throw Object.assign(new Error("package_cache_storage_unavailable"),{status:507});
      for(let offset=0;offset<bytes.length;){const written=await file.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new Error("package_cache_write_failed");offset+=written.bytesWritten}
      hash.update(bytes);size+=bytes.length;remaining-=bytes.length;probeBytes+=bytes.length;progress();
    }
    if(declared&&size!==declared)throw new Error("upstream_content_length_invalid");
    signal.throwIfAborted();
    await file.sync();await file.close();file=null;await rename(temporary,path);
    return {path,size,sha256:hash.digest("hex")};
  }catch(error){
    await response.body?.cancel().catch(()=>{});
    if(error.code==="ENOSPC"||error.code==="EDQUOT")throw Object.assign(new Error("package_cache_storage_unavailable"),{status:507});
    throw error;
  }finally{
    await file?.close();
    await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error});
  }
}

async function bufferedMetadata(path) {
  return bufferedMediaResponse(new Response(Readable.toWeb(createReadStream(path))),{copies:8});
}

function boundedMilliseconds(value, name, { minimum = 1, maximum = 120_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function retryDelays(value) {
  if (!Array.isArray(value) || value.length > 4) throw new TypeError("Package proxy upstream retry delays are invalid");
  return Object.freeze(value.map((delay) => boundedMilliseconds(
    delay,
    "Package proxy upstream retry delay",
    { minimum: 0, maximum: 30_000 },
  )));
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableUpstreamError(error) {
  if (error?.message === "upstream_package_unavailable") return error.status !== 404;
  return !new Set([
    "package_cache_storage_unavailable",
    "upstream_content_length_invalid",
    "media_memory_unavailable",
    "upstream_target_denied",
    "upstream_redirect_invalid",
  ]).has(error?.message);
}

async function atomicWrite(filename, contents) {
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.next`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

function responseHeaders(metadata, source) {
  return {
    "cache-control": "private, max-age=0, must-revalidate",
    connection: "close",
    "content-type": metadata.contentType,
    "x-content-type-options": "nosniff",
    "x-teamaibox-source": source,
    "x-teamaibox-upstream-sha256": `sha256:${metadata.sha256}`,
  };
}

function rewritePipHtml(bytes) {
  const text = bytes.toString("utf8");
  return Buffer.from(text.replace(/href=(["'])([^"']+)\1/gi, (match, quote, raw) => {
    let target;
    try { target = new URL(raw, UPSTREAMS.pipIndex); } catch { throw new Error("pip_upstream_link_invalid"); }
    if (target.protocol !== "https:" || target.hostname !== "files.pythonhosted.org" || target.username || target.password) {
      throw new Error("pip_upstream_link_denied");
    }
    const fragment = target.hash;
    target.hash = "";
    const filename = target.pathname.split("/").at(-1);
    if (!filename || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(filename)) throw new Error("pip_upstream_filename_invalid");
    return `href=${quote}/pip/files/${encodeTarget(target)}/${encodeURIComponent(filename)}${fragment}${quote}`;
  }));
}

function rewriteNpmMetadata(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("npm_upstream_metadata_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("npm_upstream_metadata_invalid");
  for (const declaration of Object.values(value.versions ?? {})) {
    if (!declaration?.dist || typeof declaration.dist.tarball !== "string") continue;
    let target;
    try { target = new URL(declaration.dist.tarball); } catch { throw new Error("npm_upstream_tarball_invalid"); }
    if (target.protocol !== "https:" || target.hostname !== "registry.npmjs.org" || target.username || target.password || target.hash) {
      throw new Error("npm_upstream_tarball_denied");
    }
    declaration.dist.tarball = `http://source-gateway:8080/npm/tarballs/${encodeTarget(target)}`;
  }
  return Buffer.from(JSON.stringify(value));
}

function safeAptPath(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")
    || !/^(?:dists|pool)\/[A-Za-z0-9][A-Za-z0-9._/+~-]{1,1023}$/.test(value)) {
    throw new Error("apt_path_invalid");
  }
  return value;
}

function safeNpmPath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0") || value.split("/").includes("..")
    || !/^(?:@?[A-Za-z0-9._~-]+(?:%2[fF]|\/)?)*[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error("npm_package_invalid");
  }
  return value;
}

export function createPackageProxyServer({
  cacheRoot,
  fetchImplementation = globalThis.fetch,
  clock = () => new Date(),
  availableDisk = null,
  upstreamAttemptTimeoutMilliseconds = DEFAULT_UPSTREAM_ATTEMPT_TIMEOUT_MILLISECONDS,
  upstreamRetryDelaysMilliseconds = DEFAULT_UPSTREAM_RETRY_DELAYS_MILLISECONDS,
} = {}) {
  const root = safeCacheRoot(cacheRoot);
  availableDisk ??= async () => {const fs=await statfs(root);return fs.bavail*fs.bsize;};
  if(typeof availableDisk!=="function")throw new TypeError("Package cache disk observation is required");
  if (typeof fetchImplementation !== "function") throw new TypeError("Package proxy fetch implementation is required");
  const attemptTimeout = boundedMilliseconds(
    upstreamAttemptTimeoutMilliseconds,
    "Package proxy upstream attempt timeout",
  );
  const delays = retryDelays(upstreamRetryDelaysMilliseconds);
  const stats = Object.fromEntries(["pip", "npm", "apt"].map((key) => [key, {
    requests: 0, cacheHits: 0, upstreamFetches: 0, upstreamBytes: 0,
  }]));
  const pending = new Map();

  async function upstreamAttempt(target, ecosystem, bodyPath, accept) {
    let current = target;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (current.protocol !== "https:" || current.username || current.password || current.hash
        || !ALLOWED_HOSTS[ecosystem].has(current.hostname)) throw new Error("upstream_target_denied");
      const controller = new AbortController();
      let timeout;
      const progress=()=>{clearTimeout(timeout);timeout=setTimeout(()=>controller.abort(new Error("upstream_timeout")),attemptTimeout)};
      progress();
      try {
        const response = await fetchImplementation(current, {
          redirect: "manual",
          headers: { accept, "user-agent": "TeamAIBox-SourceGateway/1.0" },
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === MAX_REDIRECTS) throw new Error("upstream_redirect_invalid");
          await response.body?.cancel();
          current = new URL(location, current);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error("upstream_package_unavailable");
          error.status = response.status === 404 ? 404 : 502;
          throw error;
        }
        const artifact = await downloadFile(response, bodyPath, {signal:controller.signal,progress,availableDisk});
        return {
          ...artifact,
          contentType: String(response.headers.get("content-type") ?? "application/octet-stream").slice(0, 256),
          fetchedFrom: current.href,
        };
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("upstream_redirect_invalid");
  }

  async function upstream(target, ecosystem, bodyPath, accept) {
    let lastError;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        return await upstreamAttempt(target, ecosystem, bodyPath, accept);
      } catch (error) {
        lastError = error?.message === "upstream_timeout" || error?.name === "AbortError"
          ? Object.assign(new Error("upstream_timeout"), { status: 502 })
          : error;
        if (!retryableUpstreamError(lastError) || attempt === delays.length) throw lastError;
        await pause(delays[attempt]);
      }
    }
    throw lastError;
  }

  async function cached(target, ecosystem, accept) {
    const identity = sha256(Buffer.from(`${ecosystem}\0${target.href}`));
    const directory = join(root, ecosystem);
    const bodyPath = join(directory, `${identity}.bin`);
    const metadataPath = join(directory, `${identity}.json`);
    await mkdir(directory, { recursive: true });
    try {
      const [body, raw] = await Promise.all([hashFile(bodyPath), readFile(metadataPath)]);
      const metadata = JSON.parse(raw.toString("utf8"));
      if (body.size !== metadata.size || !SHA256.test(metadata.sha256) || body.sha256 !== metadata.sha256
        || metadata.target !== target.href || metadata.ecosystem !== ecosystem) throw new Error("package_cache_corrupted");
      stats[ecosystem].cacheHits += 1;
      return { path: bodyPath, metadata, source: "cache" };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!pending.has(identity)) {
      pending.set(identity, (async () => {
        const result = await upstream(target, ecosystem, bodyPath, accept);
        const metadata = {
          schemaVersion: 1,
          ecosystem,
          target: target.href,
          fetchedFrom: result.fetchedFrom,
          fetchedAt: clock().toISOString(),
          contentType: result.contentType,
          size: result.size,
          sha256: result.sha256,
        };
        await atomicWrite(metadataPath, Buffer.from(JSON.stringify(metadata) + "\n"));
        stats[ecosystem].upstreamFetches += 1;
        stats[ecosystem].upstreamBytes += result.size;
        return { path: bodyPath, metadata, source: "upstream" };
      })().finally(() => pending.delete(identity)));
    }
    return pending.get(identity);
  }

  async function route(request, response) {
    const target = new URL(request.url ?? "/", "http://source-gateway:8080");
    if (request.method === "GET" && new Set(["/health/live", "/health/ready"]).has(target.pathname)) {
      json(response, 200, { schemaVersion: 1, status: target.pathname.endsWith("ready") ? "ready" : "live", stats });
      return;
    }
    if (!new Set(["GET", "HEAD"]).has(request.method) || target.search) {
      json(response, 405, { error: { code: "source_method_not_allowed", message: "Only native read-only package requests are accepted" } });
      return;
    }
    let ecosystem, result, bytes;
    if (target.pathname === "/pip/simple/") {
      json(response, 404, { error: { code: "pip_project_required", message: "A Python project name is required" } });
      return;
    }
    const pipProject = /^\/pip\/simple\/([^/]+)\/$/.exec(target.pathname);
    const pipFile = /^\/pip\/files\/([A-Za-z0-9_-]{16,2047})\/([A-Za-z0-9][A-Za-z0-9._+%-]{0,764})$/.exec(target.pathname);
    const npmMetadata = target.pathname.startsWith("/npm/registry/") ? target.pathname.slice("/npm/registry/".length) : null;
    const npmTarball = /^\/npm\/tarballs\/([A-Za-z0-9_-]{16,4096})$/.exec(target.pathname);
    if (pipProject) {
      const project = decodeURIComponent(pipProject[1]);
      if (!PROJECT.test(project)) throw new Error("pip_project_invalid");
      ecosystem = "pip";
      result = await cached(new URL(`${encodeURIComponent(project)}/`, UPSTREAMS.pipIndex), ecosystem, "text/html");
      bytes = rewritePipHtml(await bufferedMetadata(result.path));
    } else if (pipFile) {
      ecosystem = "pip";
      const artifactTarget = decodeTarget(pipFile[1], ecosystem);
      const requestedFilename = decodeURIComponent(pipFile[2]);
      const artifactFilename = artifactTarget.pathname.split("/").at(-1);
      const metadataRequest = requestedFilename === `${artifactFilename}.metadata`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,263}$/.test(requestedFilename)
        || (requestedFilename !== artifactFilename && !metadataRequest)) throw new Error("pip_upstream_filename_invalid");
      result = await cached(
        metadataRequest ? new URL(`${artifactTarget.href}.metadata`) : artifactTarget,
        ecosystem,
        metadataRequest ? "application/octet-stream" : "application/octet-stream",
      );
    } else if (npmMetadata !== null) {
      ecosystem = "npm";
      const path = safeNpmPath(npmMetadata);
      result = await cached(new URL(path, UPSTREAMS.npmRegistry), ecosystem, "application/vnd.npm.install-v1+json, application/json");
      bytes = rewriteNpmMetadata(await bufferedMetadata(result.path));
    } else if (npmTarball) {
      ecosystem = "npm";
      result = await cached(decodeTarget(npmTarball[1], ecosystem), ecosystem, "application/octet-stream");
    } else if (target.pathname.startsWith("/apt/")) {
      ecosystem = "apt";
      const path = safeAptPath(target.pathname.slice("/apt/".length));
      result = await cached(new URL(path, UPSTREAMS.aptRepository), ecosystem, "*/*");
    } else {
      json(response, 404, { error: { code: "source_route_not_found", message: "Package source route was not found" } });
      return;
    }
    stats[ecosystem].requests += 1;
    response.writeHead(200, { ...responseHeaders(result.metadata, result.source), "content-length": String(bytes?.byteLength ?? result.metadata.size) });
    if(request.method==="HEAD"||bytes)response.end(request.method==="HEAD"?undefined:bytes);
    else await pipeline(createReadStream(result.path),response);
  }

  return createServer((request, response) => {
    void route(request, response).catch((error) => {
      if(response.headersSent||response.destroyed){response.destroy();return;}
      const code = /^[a-z][a-z0-9_]{2,127}$/.test(error?.message ?? "") ? error.message : "source_gateway_failed";
      json(response, Number.isSafeInteger(error?.status) ? error.status : code.includes("denied") ? 403 : code.includes("invalid") ? 400 : 502, {
        error: { code, message: "The requested package is unavailable through the configured internal source" },
      }, { "x-teamaibox-error-code": code });
    });
  });
}

export const packageProxyContract = Object.freeze({
  listenHost: "0.0.0.0",
  listenPort: 8080,
  internalOrigins: Object.freeze({
    pip: "http://source-gateway:8080/pip/simple/",
    npm: "http://source-gateway:8080/npm/registry/",
    apt: "http://source-gateway:8080/apt",
  }),
  upstreams: Object.freeze(Object.fromEntries(Object.entries(UPSTREAMS).map(([key, value]) => [key, value.href]))),
});
