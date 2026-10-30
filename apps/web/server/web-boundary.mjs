import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { createSecureContext } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROXY_PREFIXES = Object.freeze(["/api", "/v1", "/events", "/realtime", "/ws"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

export class WebBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebBoundaryError";
    this.code = code;
  }
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WebBoundaryError("invalid_configuration", "boolean configuration must be true or false");
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WebBoundaryError("invalid_configuration", `${name} is outside its supported range`);
  }
  return parsed;
}

function safeIdentifier(value, fallback, name) {
  const selected = value || fallback;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(selected)) {
    throw new WebBoundaryError("invalid_configuration", `${name} is invalid`);
  }
  return selected;
}

function optionalAbsoluteFile(value, name) {
  if (!value) return null;
  if (!value.startsWith("/")) {
    throw new WebBoundaryError("invalid_configuration", `${name} must be an absolute path`);
  }
  return resolve(value);
}

function originUrl(value, { required = false, protocols, name }) {
  if (!value) {
    if (required) throw new WebBoundaryError("invalid_configuration", `${name} is required`);
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebBoundaryError("invalid_configuration", `${name} is not a valid URL`);
  }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new WebBoundaryError("invalid_configuration", `${name} must be an origin using ${protocols.join(" or ")}`);
  }
  return parsed;
}

function publicConfiguration(config) {
  return Object.freeze({
    apiBase: "/api",
    classification: config.developmentSyntheticOnly
      ? "isolated-development-synthetic-only"
      : config.mode === "release" ? "supported-authenticated" : "internal",
    deploymentSlot: config.deploymentSlot,
    mode: config.mode,
    releaseEvidenceEligible: config.mode === "release" && !config.developmentSyntheticOnly,
    releaseId: config.releaseId,
    transport: config.tls ? "https" : "http",
  });
}

export function loadWebBoundaryConfiguration(environment = process.env) {
  const mode = environment.WEB_MODE || "release";
  if (!new Set(["development", "internal", "release"]).has(mode)) {
    throw new WebBoundaryError("invalid_configuration", "WEB_MODE must be development, internal, or release");
  }
  const tlsCertificateFile = environment.WEB_TLS_CERT_FILE || null;
  const tlsKeyFile = environment.WEB_TLS_KEY_FILE || null;
  if (Boolean(tlsCertificateFile) !== Boolean(tlsKeyFile)) {
    throw new WebBoundaryError("invalid_configuration", "TLS certificate and private-key files must be configured together");
  }
  const tls = Boolean(tlsCertificateFile && tlsKeyFile);
  const allowInsecureHttp = booleanValue(environment.WEB_ALLOW_INSECURE_HTTP, false);
  if (!tls && mode !== "internal" && (mode !== "development" || !allowInsecureHttp)) {
    throw new WebBoundaryError(
      "https_required",
      "plain HTTP is allowed only when WEB_MODE=development and WEB_ALLOW_INSECURE_HTTP=true",
    );
  }

  const publicOrigin = originUrl(environment.WEB_PUBLIC_ORIGIN, {
    required: mode === "release",
    protocols: tls ? ["https:"] : ["http:"],
    name: "WEB_PUBLIC_ORIGIN",
  });
  const platformApiOrigin = originUrl(environment.PLATFORM_API_ORIGIN || "http://platform-api:8080", {
    required: true,
    protocols: ["http:", "https:"],
    name: "PLATFORM_API_ORIGIN",
  });
  const applicationOrigin = originUrl(environment.WEB_APPLICATION_ORIGIN, {
    required: false,
    protocols: ["http:", "https:"],
    name: "WEB_APPLICATION_ORIGIN",
  });
  const developmentDemo = booleanValue(environment.WEB_DEVELOPMENT_DEMO, false);
  if (developmentDemo && mode !== "development") {
    throw new WebBoundaryError("invalid_configuration", "the development browser bootstrap cannot be enabled in release mode");
  }
  const developmentSyntheticOnly = booleanValue(environment.WEB_DEVELOPMENT_SYNTHETIC_ONLY, false);
  if (developmentSyntheticOnly && (mode !== "development" || !developmentDemo)) {
    throw new WebBoundaryError("invalid_configuration", "synthetic-only preview requires development mode and the development browser bootstrap");
  }
  const developmentPermissions = (environment.WEB_DEVELOPMENT_PERMISSIONS || "")
    .split(",")
    .map((permission) => permission.trim())
    .filter(Boolean);
  if (developmentPermissions.some((permission) => !/^[a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)+$/.test(permission))) {
    throw new WebBoundaryError("invalid_configuration", "WEB_DEVELOPMENT_PERMISSIONS contains an invalid permission");
  }

  if (developmentSyntheticOnly && (applicationOrigin || environment.WEB_PLUGIN_ROUTES_FILE)) {
    throw new WebBoundaryError("invalid_configuration", "synthetic-only preview cannot configure application or plugin proxy routes");
  }

  return Object.freeze({
    allowInsecureHttp,
    autoLocalAddress: tls && booleanValue(environment.WEB_AUTO_LOCAL_ADDRESS, false),
    applicationOrigin,
    developmentDemo,
    developmentSyntheticOnly,
    developmentPermissions: Object.freeze([...new Set(developmentPermissions)].sort()),
    deploymentSlot: safeIdentifier(environment.WEB_DEPLOYMENT_SLOT, "blue", "WEB_DEPLOYMENT_SLOT"),
    host: environment.WEB_HOST || "0.0.0.0",
    mode,
    platformApiOrigin,
    pluginRoutesFile: optionalAbsoluteFile(environment.WEB_PLUGIN_ROUTES_FILE, "WEB_PLUGIN_ROUTES_FILE"),
    port: boundedInteger(environment.WEB_PORT, tls ? 8443 : 8080, 1, 65535, "WEB_PORT"),
    publicOrigin,
    releaseId: safeIdentifier(environment.WEB_RELEASE_ID, "development", "WEB_RELEASE_ID"),
    requestTimeoutMs: boundedInteger(environment.WEB_UPSTREAM_TIMEOUT_MS, 30_000, 1_000, 300_000, "WEB_UPSTREAM_TIMEOUT_MS"),
    staticRoot: resolve(environment.WEB_STATIC_ROOT || DEFAULT_STATIC_ROOT),
    tls,
    tlsCertificateFile,
    tlsKeyFile,
  });
}

function certificateState(certificatePem, { expectedHost = null, now = new Date(), requireLeaf = false } = {}) {
  let certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new WebBoundaryError("invalid_certificate", "TLS certificate cannot be parsed");
  }
  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (notBefore > now || notAfter <= now) {
    throw new WebBoundaryError("invalid_certificate", "TLS certificate is not currently valid");
  }
  if (requireLeaf && certificate.ca) {
    throw new WebBoundaryError("invalid_certificate", "TLS certificate must be a server leaf certificate");
  }
  if (expectedHost) {
    const host = expectedHost.startsWith("[") && expectedHost.endsWith("]")
      ? expectedHost.slice(1, -1)
      : expectedHost;
    const match = isIP(host)
      ? certificate.checkIP(host)
      : certificate.checkHost(host, { subject: "never" });
    if (!match) throw new WebBoundaryError("invalid_certificate", "TLS certificate does not match WEB_PUBLIC_ORIGIN");
  }
  return Object.freeze({
    fingerprint256: certificate.fingerprint256,
    notAfter: notAfter.toISOString(),
  });
}

async function loadTlsMaterial(config) {
  if (!config.tls) return null;
  const [cert, key] = await Promise.all([
    readFile(config.tlsCertificateFile, "utf8"),
    readFile(config.tlsKeyFile, "utf8"),
  ]);
  const state = certificateState(cert, {
    // In appliance mode the root-owned host agent maintains the current SANs.
    // publicOrigin remains the internal API origin, not a DHCP address pin.
    expectedHost: config.mode === "release" && !config.autoLocalAddress ? config.publicOrigin?.hostname : null,
    requireLeaf: config.mode === "release",
  });
  try { createSecureContext({ cert, key }); }
  catch { throw new WebBoundaryError("invalid_certificate", "TLS certificate and private key cannot create a secure context"); }
  return Object.freeze({ cert, key, state, certificate: new X509Certificate(cert) });
}

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

function securityHeaders(config) {
  const headers = {
    "content-security-policy": "default-src 'self'; base-uri 'self'; connect-src 'self' ws: wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    // The shell must permit delegation to the same-origin virtual-phone
    // frame. Individual plugin responses remain denied unless explicitly
    // selected below; this never grants the browser's user permission.
    "permissions-policy": "camera=(self), geolocation=(), microphone=(self), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (config.tls) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function applySecurityHeaders(response, config) {
  for (const [name, value] of Object.entries(securityHeaders(config))) response.setHeader(name, value);
}

function jsonResponse(response, config, status, value, additionalHeaders = {}) {
  applySecurityHeaders(response, config);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...additionalHeaders,
  });
  response.end(JSON.stringify(value));
}

function pluginLoginRequired(request, response, config, requestId) {
  if (!(request.headers.accept || "").includes("text/html")) {
    jsonResponse(response, config, 401, { error: { code: "invalid_session", requestId } });
    return;
  }
  const english = new URL(request.url, "http://teamaibox.invalid").searchParams.get("locale") === "en";
  const title = english ? "Please sign in again" : "请重新登录";
  const message = english ? "Your platform session has expired. Sign in to continue using this app."
    : "平台登录已过期。重新登录后即可继续使用应用，这不代表应用服务故障。";
  const action = english ? "Back to sign in" : "返回登录";
  applySecurityHeaders(response, config);
  response.setHeader("content-security-policy", securityHeaders(config)["content-security-policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.writeHead(401, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
  // A fixed same-origin link works both in an application frame and in a
  // standalone desktop tab. No token, return URL or protected data is exposed.
  const html = `<!doctype html><html lang="${english ? "en" : "zh-CN"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{margin:0;font:16px system-ui;background:light-dark(#f6f5ef,#19241e);color:light-dark(#203329,#e6eee8);display:grid;min-height:100vh;place-items:center}main{padding:32px;max-width:32rem}h1{font-size:24px}p{line-height:1.7}a{display:inline-block;padding:12px 20px;border-radius:12px;background:#237556;color:white;text-decoration:none}a:focus-visible{outline:3px solid #79bf9b;outline-offset:4px}</style><main><h1>${title}</h1><p>${message}</p><a href="/" target="_top">${action}</a></main></html>`;
  response.end(request.method === "HEAD" ? undefined : html);
}

function pluginTemporarilyUnavailable(request, response, config, requestId, code = "upstream_unavailable") {
  if (!(request.headers.accept || "").includes("text/html")) {
    jsonResponse(response, config, 502, { error: { code, requestId } });
    return;
  }
  const params = new URL(request.url, "http://teamaibox.invalid").searchParams;
  const english = params.get("locale") === "en", dark = params.get("theme") === "dark";
  const title = english ? "This app is temporarily unavailable" : "应用暂时无法连接";
  const message = english ? "The app service is restarting or disconnected. Wait a moment, then reopen this page. You do not need to sign in again."
    : "应用服务正在重启或暂时断开。稍等片刻后点击重新打开，不需要重新登录。";
  const action = english ? "Reopen app" : "重新打开应用";
  applySecurityHeaders(response, config);
  response.setHeader("content-security-policy", securityHeaders(config)["content-security-policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.writeHead(502, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
  // Empty href retries this same page, without reflecting URL text or replaying
  // an operation. No timer, token, infrastructure address or script is included.
  response.end(request.method === "HEAD" ? undefined : `<!doctype html><html lang="${english ? "en" : "zh-CN"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:${dark ? "dark" : "light"}}body{margin:0;font:16px system-ui;background:${dark ? "#19241e" : "#f6f5ef"};color:${dark ? "#e6eee8" : "#203329"};display:grid;min-height:100vh;place-items:center}main{padding:32px;max-width:32rem}h1{font-size:24px}p{line-height:1.7}a{display:inline-block;padding:12px 20px;border-radius:12px;background:#237556;color:white;text-decoration:none}a:focus-visible{outline:3px solid #79bf9b;outline-offset:4px}</style><main role="alert"><h1>${title}</h1><p>${message}</p><a href="">${action}</a></main></html>`);
}

function requestPath(request) {
  try {
    return new URL(request.url || "/", "http://teamaibox.invalid").pathname;
  } catch {
    return null;
  }
}

const verifiedRequestOrigin = Symbol("verified appliance request origin");

export function applianceRequestOrigin(request, config, certificate) {
  if (!config.autoLocalAddress) return null;
  try {
    const authority = request.headers.host;
    if (typeof authority !== "string" || /[\s\\/@?#]/.test(authority)) return null;
    const url = new URL(`https://${authority}`);
    if (url.host !== authority.toLowerCase() || url.port !== config.publicOrigin.port) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const match = isIP(hostname) ? certificate.checkIP(hostname)
      : certificate.checkHost(hostname, { subject: "never", wildcards: false });
    return match ? url.origin : null;
  } catch { return null; }
}

function requestOriginAllowed(request, config) {
  const origin = request.headers.origin;
  if (!origin || !config.publicOrigin) return true;
  return origin === (config.autoLocalAddress ? request[verifiedRequestOrigin] : config.publicOrigin.origin);
}

function forwardHeaders(request, config, upstreamOrigin, requestId, websocket = false, stripCredentials = false) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP.has(normalized)) continue;
    if (stripCredentials && new Set(["authorization", "cookie", "origin", "referer", "x-csrf-token"]).has(normalized)) continue;
    headers[name] = value;
  }
  if (websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade;
  }
  headers.host = upstreamOrigin.host;
  headers["x-forwarded-for"] = request.socket.remoteAddress || "unknown";
  headers["x-forwarded-host"] = config.publicOrigin?.host || "development.invalid";
  headers["x-forwarded-proto"] = config.tls ? "https" : "http";
  headers["x-request-id"] = requestId;
  // Only translate an exact same-origin request whose Host was checked against
  // our current certificate. Never reflect arbitrary Origin/Forwarded headers.
  if (!stripCredentials && config.autoLocalAddress && request.headers.origin
      && request.headers.origin === request[verifiedRequestOrigin]) {
    headers.origin = config.publicOrigin.origin;
  }
  return headers;
}

function proxyModule(upstreamOrigin) {
  return upstreamOrigin.protocol === "https:" ? httpsRequest : httpRequest;
}

function pipeWithoutProcessFailure(source, destination) {
  const close = () => {
    if (!source.destroyed) source.destroy();
    if (!destination.destroyed) destination.destroy();
  };
  try {
    pipeline(source, destination, (error) => { if (error) close(); });
  } catch {
    close();
  }
}

function proxyHttpRequest(request, response, config, upstreamOrigin, requestId, options = {}) {
  const target = new URL(request.url || "/", upstreamOrigin);
  const upstream = proxyModule(upstreamOrigin)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: target.pathname + target.search,
    headers: forwardHeaders(request, config, upstreamOrigin, requestId, false, options.stripCredentials === true),
    timeout: config.requestTimeoutMs,
  }, (upstreamResponse) => {
    if (response.destroyed || response.writableEnded) {
      upstreamResponse.destroy();
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
    }
    if (options.embeddablePlugin === true) {
      for (const name of ["content-security-policy", "x-frame-options", "permissions-policy"]) delete headers[name];
      applySecurityHeaders(response, config);
      response.setHeader("permissions-policy", `camera=${options.phoneCamera === true ? '(self)' : '()'}, geolocation=(), microphone=(self), payment=(), usb=()`);
      response.removeHeader("x-frame-options");
      response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'self'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'");
    } else {
      applySecurityHeaders(response, config);
    }
    try {
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      // Preserve streaming semantics through the browser boundary.  Without
      // an explicit flush an idle SSE upstream has sent valid headers, but the
      // browser remains stuck in EventSource CONNECTING until a data event.
      response.flushHeaders?.();
    } catch {
      upstreamResponse.destroy();
      if (!response.destroyed) response.destroy();
      return;
    }
    pipeWithoutProcessFailure(upstreamResponse, response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!response.headersSent) {
      if (options.embeddablePlugin === true) pluginTemporarilyUnavailable(request, response, config, requestId);
      else jsonResponse(response, config, 502, { error: { code: "upstream_unavailable", requestId } });
    } else {
      response.destroy();
    }
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  pipeWithoutProcessFailure(request, upstream);
}

async function loadPluginRoutes(config) {
  if (!config.pluginRoutesFile) return Object.freeze([]);
  let document;
  try {
    document = JSON.parse(await readFile(config.pluginRoutesFile, "utf8"));
  } catch {
    throw new WebBoundaryError("invalid_plugin_routes", "WEB_PLUGIN_ROUTES_FILE cannot be read as JSON");
  }
  if (document?.schemaVersion !== 1 || !Array.isArray(document.routes)) {
    throw new WebBoundaryError("invalid_plugin_routes", "plugin routes must use schemaVersion 1");
  }
  const seen = new Set();
  const routes = document.routes.map((route) => {
    const pluginId = safeIdentifier(route?.pluginId, null, "plugin route id");
    if (!pluginId.includes(".")) throw new WebBoundaryError("invalid_plugin_routes", "plugin route id must be namespaced");
    const pathPrefix = `/plugins/${pluginId}`;
    if (route.pathPrefix !== pathPrefix || seen.has(pathPrefix)) {
      throw new WebBoundaryError("invalid_plugin_routes", "plugin route path must be unique and derived from its id");
    }
    const origin = originUrl(route.origin, {
      required: true,
      protocols: ["http:", "https:"],
      name: `plugin route origin for ${pluginId}`,
    });
    seen.add(pathPrefix);
    return Object.freeze({ origin, pathPrefix, pluginId });
  });
  return Object.freeze(routes.sort((left, right) => right.pathPrefix.length - left.pathPrefix.length));
}

function matchPluginRoute(pathname, routes) {
  return routes.find((route) => pathname === route.pathPrefix || pathname.startsWith(route.pathPrefix + "/")) ?? null;
}

function dynamicPluginId(pathname) {
  const pluginId = /^\/plugins\/([a-z][a-z0-9_.-]{1,127})(?:\/|$)/.exec(pathname)?.[1] ?? null;
  return pluginId?.includes(".") ? pluginId : null;
}

function resolveDynamicPluginRoute(request, config, pluginId, requestId) {
  const target = new URL(`/internal/v1/plugin-routes/${encodeURIComponent(pluginId)}`, config.platformApiOrigin);
  return new Promise((resolveRoute, rejectRoute) => {
    const upstream = proxyModule(config.platformApiOrigin)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "GET",
      path: target.pathname,
      headers: {
        accept: "application/json",
        host: config.platformApiOrigin.host,
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        "x-forwarded-host": config.publicOrigin?.host || "development.invalid",
        "x-forwarded-proto": config.tls ? "https" : "http",
        "x-request-id": requestId,
      },
      timeout: Math.min(config.requestTimeoutMs, 10_000),
    }, (response) => {
      const chunks = []; let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 16_384) response.destroy(new WebBoundaryError("invalid_plugin_route", "dynamic plugin route response is too large"));
        else chunks.push(chunk);
      });
      response.on("error", rejectRoute);
      response.on("end", () => {
        if (response.statusCode === 401) { resolveRoute({ loginRequired: true }); return; }
        if (new Set([403, 404]).has(response.statusCode)) { resolveRoute(null); return; }
        if (response.statusCode !== 200) { rejectRoute(new WebBoundaryError("plugin_route_unavailable", "dynamic plugin route resolver is unavailable")); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (value?.schemaVersion !== 1 || value.pluginId !== pluginId || value.pathPrefix !== `/plugins/${pluginId}`
            || value.integration !== "iframe" || value.transport !== "platform-authenticated-proxy" || "origin" in value) {
            throw new WebBoundaryError("invalid_plugin_route", "dynamic plugin route identity is invalid");
          }
          resolveRoute(Object.freeze({ pluginId, pathPrefix: value.pathPrefix, platformProxy: true }));
        } catch (error) { rejectRoute(error); }
      });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("dynamic plugin route timeout")));
    upstream.on("error", rejectRoute);
    upstream.end();
  });
}

function serializeUpgradeResponse(response) {
  const status = response.statusCode || 101;
  const message = response.statusMessage || "Switching Protocols";
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) lines.push(`${name}: ${item}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

function proxyWebSocket(request, socket, head, config, requestId) {
  const pathname = requestPath(request);
  if (!pathname || !isProxyPath(pathname) || !requestOriginAllowed(request, config)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const target = new URL(request.url || "/", config.platformApiOrigin);
  const upstream = proxyModule(config.platformApiOrigin)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: target.pathname + target.search,
    headers: forwardHeaders(request, config, config.platformApiOrigin, requestId, true),
    timeout: config.requestTimeoutMs,
  });
  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    structuredLog("web.websocket_connected", { path: pathname, requestId });
    socket.write(serializeUpgradeResponse(upstreamResponse));
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on("response", (upstreamResponse) => {
    socket.write(serializeUpgradeResponse(upstreamResponse));
    upstreamResponse.pipe(socket);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    structuredLog("web.websocket_failed", { path: pathname, requestId });
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  upstream.end();
}

function etagFor(metadata) {
  return `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`;
}

async function safeStaticFile(staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(staticRoot, relative);
  if (candidate !== staticRoot && !candidate.startsWith(staticRoot + sep)) return null;
  try {
    const linkState = await lstat(candidate);
    if (linkState.isSymbolicLink()) return null;
    const actual = await realpath(candidate);
    if (actual !== staticRoot && !actual.startsWith(staticRoot + sep)) return null;
    const metadata = await stat(actual);
    return metadata.isFile() ? { actual, metadata } : null;
  } catch {
    return null;
  }
}

function wantsSpaFallback(request, pathname) {
  if (!new Set(["GET", "HEAD"]).has(request.method || "GET")) return false;
  const applicationDeepLink = /^\/apps\/[a-z][a-z0-9.-]*\/?$/.test(pathname);
  if (extname(pathname) && !applicationDeepLink) return false;
  const accepted = request.headers.accept || "";
  return accepted === "" || accepted.includes("text/html") || accepted.includes("*/*");
}

function runtimeConfigurationSource(config) {
  const bootstrap = {
    runtime: publicConfiguration(config),
  };
  if (config.developmentDemo) {
    bootstrap.authorization = {
      identityKind: "local_user",
      permissions: config.developmentPermissions,
    };
  }
  const payload = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return `globalThis.__TEAM_AI_BOX_RUNTIME__=${payload}.runtime;\n`
    + `if(${payload}.authorization){globalThis.__TEAM_AI_BOX_AUTHORIZATION__=${payload}.authorization;}\n`;
}

async function serveStatic(request, response, config, pathname) {
  if (!new Set(["GET", "HEAD"]).has(request.method || "GET")) {
    jsonResponse(response, config, 405, { error: { code: "method_not_allowed" } }, { allow: "GET, HEAD" });
    return;
  }
  if (pathname === "/runtime-config.js") {
    applySecurityHeaders(response, config);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : runtimeConfigurationSource(config));
    return;
  }
  let selected = await safeStaticFile(config.staticRoot, pathname);
  let spaFallback = false;
  if (!selected && wantsSpaFallback(request, pathname)) {
    selected = await safeStaticFile(config.staticRoot, "/index.html");
    spaFallback = Boolean(selected);
  }
  if (!selected) {
    jsonResponse(response, config, 404, { error: { code: "not_found" } });
    return;
  }

  const etag = etagFor(selected.metadata);
  applySecurityHeaders(response, config);
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag });
    response.end();
    return;
  }
  const extension = extname(selected.actual).toLowerCase();
  const immutable = /\.[a-f0-9]{8,}\./i.test(selected.actual);
  response.writeHead(200, {
    "cache-control": extension === ".html" || spaFallback
      ? "no-store"
      : immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "content-length": selected.metadata.size,
    "content-type": MIME_TYPES[extension] || "application/octet-stream",
    etag,
  });
  if (request.method === "HEAD") response.end();
  else pipeline(createReadStream(selected.actual), response, () => {});
}

export function redactWebLogFields(fields) {
  return { ...fields, ...(typeof fields.path === "string" && fields.path.startsWith("/api/v1/casting/media/")
    ? { path: "/api/v1/casting/media/[redacted]" } : {}) };
}

function structuredLog(event, fields) {
  process.stdout.write(JSON.stringify({ event, occurredAt: new Date().toISOString(), ...redactWebLogFields(fields) }) + "\n");
}

async function canonicalStaticRoot(staticRoot) {
  const root = await realpath(staticRoot).catch(() => null);
  if (!root) throw new WebBoundaryError("static_root_unavailable", "WEB_STATIC_ROOT is unavailable");
  const index = await safeStaticFile(root, "/index.html");
  if (!index) throw new WebBoundaryError("static_root_unavailable", "the Web build has no index.html");
  return root;
}

export async function createWebBoundary({ environment = process.env } = {}) {
  const loadedConfig = loadWebBoundaryConfiguration(environment);
  const config = Object.freeze({
    ...loadedConfig,
    staticRoot: await canonicalStaticRoot(loadedConfig.staticRoot),
  });
  const pluginRoutes = await loadPluginRoutes(config);
  let tlsMaterial = await loadTlsMaterial(config);
  const handler = async (request, response) => {
    const startedAt = Date.now();
    const requestId = /^[A-Za-z0-9._-]{8,128}$/.test(request.headers["x-request-id"] || "")
      ? request.headers["x-request-id"]
      : randomUUID();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => structuredLog("web.request", {
      durationMs: Date.now() - startedAt,
      method: request.method,
      path: requestPath(request),
      requestId,
      status: response.statusCode,
    }));
    const pathname = requestPath(request);
    if (!pathname) {
      jsonResponse(response, config, 400, { error: { code: "invalid_request", requestId } });
      return;
    }
    if (config.developmentSyntheticOnly && (request.headers.authorization || request.headers.cookie)) {
      jsonResponse(response, config, 400, { error: { code: "preview_credentials_rejected", requestId } });
      return;
    }
    if (pathname === "/health/live") {
      jsonResponse(response, config, 200, { status: "live", releaseId: config.releaseId });
      return;
    }
    if (pathname === "/health/ready") {
      jsonResponse(response, config, 200, {
        status: "ready",
        releaseId: config.releaseId,
        slot: config.deploymentSlot,
        transport: config.tls ? "https" : "http",
        certificateNotAfter: tlsMaterial?.state.notAfter || null,
        certificateFingerprint256: tlsMaterial?.state.fingerprint256 || null,
      });
      return;
    }
    if (config.autoLocalAddress) {
      request[verifiedRequestOrigin] = applianceRequestOrigin(request, config, tlsMaterial.certificate);
      if (!request[verifiedRequestOrigin]) {
        jsonResponse(response, config, 421, { error: { code: "appliance_address_rejected", requestId } });
        return;
      }
    }
    if (isProxyPath(pathname)) {
      if (config.developmentSyntheticOnly) {
        jsonResponse(response, config, 403, { error: { code: "preview_synthetic_only", requestId } });
        return;
      }
      if (!requestOriginAllowed(request, config) && !SAFE_METHODS.has(request.method || "GET")) {
        jsonResponse(response, config, 403, { error: { code: "origin_rejected", requestId } });
        return;
      }
      proxyHttpRequest(request, response, config, config.platformApiOrigin, requestId);
      return;
    }
    let pluginRoute = matchPluginRoute(pathname, pluginRoutes);
    const runtimePluginId = pluginRoute ? null : dynamicPluginId(pathname);
    if (!pluginRoute && runtimePluginId) {
      if (!new Set(["GET", "HEAD"]).has(request.method || "GET")) {
        jsonResponse(response, config, 405, { error: { code: "method_not_allowed", requestId } }, { allow: "GET, HEAD" });
        return;
      }
      try { pluginRoute = await resolveDynamicPluginRoute(request, config, runtimePluginId, requestId); }
      catch {
        pluginTemporarilyUnavailable(request, response, config, requestId, "plugin_route_unavailable");
        return;
      }
      if (pluginRoute?.loginRequired) {
        pluginLoginRequired(request, response, config, requestId);
        return;
      }
      if (!pluginRoute) {
        jsonResponse(response, config, 404, { error: { code: "plugin_route_unavailable", requestId } });
        return;
      }
    }
    if (pluginRoute) {
      if (!new Set(["GET", "HEAD"]).has(request.method || "GET")) {
        jsonResponse(response, config, 405, { error: { code: "method_not_allowed", requestId } }, { allow: "GET, HEAD" });
        return;
      }
      proxyHttpRequest(request, response, config, pluginRoute.platformProxy ? config.platformApiOrigin : pluginRoute.origin, requestId, {
        embeddablePlugin: true,
        phoneCamera: pluginRoute.pluginId === 'official.virtual-phones',
        stripCredentials: pluginRoute.platformProxy !== true,
      });
      return;
    }
    if (config.applicationOrigin && pathname !== "/runtime-config.js") {
      proxyHttpRequest(request, response, config, config.applicationOrigin, requestId);
      return;
    }
    await serveStatic(request, response, config, pathname);
  };

  const server = config.tls
    ? createHttpsServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
    : createHttpServer(handler);
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.requestTimeout = config.requestTimeoutMs + 5_000;
  server.headersTimeout = Math.min(server.requestTimeout, 35_000);
  server.keepAliveTimeout = 5_000;
  server.on("upgrade", (request, socket, head) => {
    if (config.autoLocalAddress) {
      request[verifiedRequestOrigin] = applianceRequestOrigin(request, config, tlsMaterial.certificate);
      if (!request[verifiedRequestOrigin]) {
        socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
    }
    const requestId = /^[A-Za-z0-9._-]{8,128}$/.test(request.headers["x-request-id"] || "")
      ? request.headers["x-request-id"]
      : randomUUID();
    if (config.developmentSyntheticOnly) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    proxyWebSocket(request, socket, head, config, requestId);
  });

  return Object.freeze({
    config,
    server,
    async close() {
      const closed = new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      for (const socket of connections) socket.destroy();
      await closed;
    },
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(config.port, config.host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      structuredLog("web.started", {
        address: typeof address === "object" && address ? address.address : String(address),
        port: typeof address === "object" && address ? address.port : config.port,
        releaseId: config.releaseId,
        slot: config.deploymentSlot,
        transport: config.tls ? "https" : "http",
      });
      return address;
    },
    async reloadTls() {
      if (!config.tls) throw new WebBoundaryError("tls_disabled", "TLS is not enabled");
      const next = await loadTlsMaterial(config);
      server.setSecureContext({ cert: next.cert, key: next.key });
      tlsMaterial = next;
      structuredLog("web.tls_reloaded", {
        certificateFingerprint256: next.state.fingerprint256,
        certificateNotAfter: next.state.notAfter,
        releaseId: config.releaseId,
      });
      return next.state;
    },
  });
}

async function main() {
  const boundary = await createWebBoundary();
  await boundary.listen();
  process.on("SIGHUP", () => {
    void boundary.reloadTls().catch((error) => structuredLog("web.tls_reload_failed", { code: error.code || "failed" }));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void boundary.close().finally(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    structuredLog("web.start_failed", { code: error.code || "failed", messageHash: createHash("sha256").update(error.message).digest("hex") });
    process.exitCode = 1;
  });
}
