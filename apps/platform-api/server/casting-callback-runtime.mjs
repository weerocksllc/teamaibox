import { createServer } from "node:https";
import { isIP } from "node:net";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { TrustedMediaCallbackHttpApi, trustedMediaTransportIdentity,
  validateTrustedMediaCallbackContract } from "../src/casting/trusted-media-callback-api.mjs";

const SETTINGS = ["PLATFORM_CASTING_CALLBACK_HOST", "PLATFORM_CASTING_CALLBACK_PORT",
  "PLATFORM_CASTING_CALLBACK_CONTRACT_FILE", "PLATFORM_CASTING_CALLBACK_CA_FILE",
  "PLATFORM_CASTING_CALLBACK_CERT_FILE", "PLATFORM_CASTING_CALLBACK_KEY_FILE"];
const invalid = () => new TypeError("Casting callback private listener configuration is invalid");
function privateAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

export function castingCallbackConfigured(environment = process.env) {
  const count = SETTINGS.filter(name => Boolean(environment[name])).length;
  if (count !== 0 && count !== SETTINGS.length) throw new TypeError("Casting callback settings must be provided together");
  if (count && (!privateAddress(environment[SETTINGS[0]])
    || !/^[1-9][0-9]{0,4}$/.test(environment[SETTINGS[1]]) || Number(environment[SETTINGS[1]]) > 65535)) throw invalid();
  return count === SETTINGS.length;
}

async function protectedFile(path) {
  if (!isAbsolute(path ?? "") || await realpath(path) !== path) throw invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 65536) throw invalid();
    const result = Buffer.alloc(before.size + 1);
    try {
      const { bytesRead } = await handle.read(result, 0, result.length, 0), after = await handle.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw invalid();
      return Buffer.from(result.subarray(0, bytesRead));
    } finally { result.fill(0); }
  } finally { await handle.close(); }
}

// Private sibling of the public HTTP server, never a reverse-proxy route.
// There is intentionally no request logger, body echo, forwarded identity or
// generic URL dispatcher on this listener. Pairing secrets live only in RAM.
export function createCastingCallbackRuntime({ service, contract, host, port, ca, cert, key, clock = () => new Date() }) {
  if (!privateAddress(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw invalid();
  const binding = validateTrustedMediaCallbackContract(contract, { requireRuntimeBinding: true });
  const api = new TrustedMediaCallbackHttpApi({ service, contract, clock });
  const startedAt = +clock(), sockets = new Set();
  let closing = false, closePromise, active = 0, serverClosed = false, finishClose;
  function drained() { if (closing && serverClosed && active === 0 && finishClose) { api.close(); finishClose(); } }
  const reject = (code, status = 400) => new PlatformError(code, "Casting callback rejected", { status });
  function reply(response, status, body) {
    const raw = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(raw.length),
      "cache-control": "no-store", connection: "close", "x-content-type-options": "nosniff" });
    response.end(raw, () => raw.fill(0));
  }
  const server = createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true,
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3", handshakeTimeout: 3000, maxHeaderSize: 8192,
    headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1 }, async (request, response) => {
    const chunks = []; let raw, body, counted = false;
    const deadline = setTimeout(() => request.destroy(), 5000).unref();
    try {
      if (closing || active >= 16) throw reject("cast_callback_unavailable", 503);
      ++active; counted = true;
      const identity = trustedMediaTransportIdentity(request);
      // Authenticate the pinned peer before reading any secret body.
      if (identity.subjectServiceIdentityId !== binding.serviceIdentityId
        || identity.certificateFingerprint !== binding.certificateFingerprint) throw reject("cast_callback_mtls_required", 401);
      if (!api.matches(request.method, request.url)) throw reject("not_found", 404);
      const names = request.rawHeaders.filter((_, i) => i % 2 === 0).map(name => name.toLowerCase());
      const length = request.headers["content-length"];
      if (new Set(names).size !== names.length || request.headers["transfer-encoding"] || request.headers["content-encoding"]
        || request.headers.expect || request.headers["content-type"] !== "application/json"
        || !/^[0-9]{1,5}$/.test(length ?? "") || +length < 2 || +length > binding.maximumRequestBytes) {
        throw reject("cast_callback_invalid");
      }
      const issued = Date.parse(request.headers[binding.issuedAtHeader] ?? "");
      if (!Number.isFinite(issued) || issued < startedAt) throw reject("cast_callback_stale", 401);
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > +length) throw reject("cast_callback_invalid");
        chunks.push(Buffer.from(part));
      }
      if (closing || request.destroyed && !request.complete) throw reject("cast_callback_unavailable", 503);
      if (size !== +length) throw reject("cast_callback_invalid");
      raw = Buffer.concat(chunks);
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw reject("cast_callback_invalid"); }
      const result = await api.handle({ method: request.method, pathname: request.url, body,
        headers: request.headers, transportIdentity: identity });
      if (!response.destroyed) reply(response, result.status, result.body);
    } catch (error) {
      // Service error messages/details may contain user input; never echo them.
      const code = error instanceof PlatformError && /^cast_[a-z0-9_]{1,100}$/.test(error.code)
        ? error.code : error?.code === "not_found" ? "not_found" : "cast_callback_unavailable";
      const status = error instanceof PlatformError ? error.status : 503;
      if (!response.destroyed && !response.headersSent) reply(response, status, { error: { code } });
    } finally {
      clearTimeout(deadline); raw?.fill(0); chunks.forEach(chunk => chunk.fill(0));
      body = null; if (counted) --active; drained();
    }
  });
  server.maxConnections = 32;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("tlsClientError", () => {}); // No peer certificate/body logging.
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => reply(response, 417, { error: { code: "cast_callback_invalid" } }));
  server.on("upgrade", (_request, socket) => socket.destroy());
  return Object.freeze({
    address: () => server.address(),
    listening: () => server.listening && !closing,
    async listen() {
      if (closing || server.listening) throw invalid();
      await new Promise((resolve, rejectPromise) => {
        const failed = error => { server.removeListener("listening", ready); rejectPromise(error); };
        const ready = () => { server.removeListener("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready); server.listen(port, host);
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise(resolve => {
        finishClose = resolve;
        for (const socket of sockets) socket.destroy();
        server.close(() => { serverClosed = true; drained(); });
      });
      return closePromise;
    },
  });
}

export async function createCastingCallbackRuntimeFromEnvironment(environment, { service }) {
  if (!castingCallbackConfigured(environment)) throw invalid();
  const bytes = [];
  try {
    for (const name of SETTINGS.slice(2)) bytes.push(await protectedFile(environment[name]));
    return createCastingCallbackRuntime({ service, host: environment[SETTINGS[0]], port: Number(environment[SETTINGS[1]]),
      contract: JSON.parse(bytes[0].toString("utf8")), ca: bytes[1], cert: bytes[2], key: bytes[3] });
  } finally { bytes.forEach(value => value.fill(0)); }
}
