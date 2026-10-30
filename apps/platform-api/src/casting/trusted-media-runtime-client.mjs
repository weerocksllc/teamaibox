import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROWSER_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const RECEIVER_NAME = /^Team-AI-[0-9A-F]{10}$/;
const SINKS = new Set(["browser"]);
const MAX_RESPONSE_BYTES = 64 * 1024;

function invalid(message) { throw new TypeError(message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function uuid(value, name) {
  if (!UUID.test(value ?? "")) invalid(`${name} is invalid`);
  return value.toLowerCase();
}
function pem(value, label, pattern) {
  if (!(value instanceof Uint8Array) || value.byteLength < 64 || value.byteLength > 1024 * 1024) {
    invalid(`${label} is invalid`);
  }
  const copy = Buffer.from(value);
  if (!pattern.test(copy.toString("utf8"))) { copy.fill(0); invalid(`${label} is invalid`); }
  return copy;
}
function privateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168) || parts[0] === 127);
}
function runtimeOrigin(value) {
  const parsed = new URL(value);
  const privateHost = isIP(parsed.hostname) === 4 ? privateIpv4(parsed.hostname)
    : parsed.hostname === "trusted-media" || parsed.hostname.endsWith(".teamaibox.internal");
  if (parsed.protocol !== "https:" || !privateHost || parsed.pathname !== "/" || parsed.search || parsed.hash
    || parsed.username || parsed.password) invalid("trusted media runtime origin is invalid");
  return parsed.origin;
}
function canonicalExpiry(value) {
  // SessionService and the PostgreSQL repository use Date internally. The
  // private wire contract remains a canonical ISO string, never a number or
  // an arbitrary object with a user-supplied conversion method.
  if (value instanceof Date && Number.isFinite(value.getTime())) value = value.toISOString();
  if (typeof value !== "string") invalid("trusted media expiry is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid("trusted media expiry is invalid");
  return value;
}
function outputSinks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || new Set(value).size !== value.length
    || value.some((item) => !SINKS.has(item))) invalid("trusted media output sinks are invalid");
  return ["browser"].filter((item) => value.includes(item));
}

function unavailable() {
  return new PlatformError("cast_media_runtime_unavailable", "Trusted media runtime is unavailable", {
    status: 503, retryable: true,
  });
}

export class NodeMtlsCastingTransport {
  async request({ origin, path, method, body, ca, cert, key, serverName, timeoutMilliseconds, signal }) {
    const target = new URL(path, `${origin}/`);
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    try {
      return await new Promise((resolve, reject) => {
        const request = httpsRequest(target, {
          method,
          ca,
          cert,
          key,
          servername: serverName,
          minVersion: "TLSv1.3",
          rejectUnauthorized: true,
          signal,
          headers: {
            accept: "application/json",
            "x-teamaibox-request-id": randomUUID(),
            "x-teamaibox-request-issued-at": new Date().toISOString(),
            ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.byteLength) } : {}),
          },
        }, (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES) response.destroy(unavailable());
            else chunks.push(Buffer.from(chunk));
          });
          response.on("end", () => {
            const raw = Buffer.concat(chunks, size);
            try {
              const responseBody = raw.byteLength ? JSON.parse(raw.toString("utf8")) : null;
              resolve({ status: response.statusCode ?? 0, body: responseBody });
            } catch { reject(unavailable()); }
            finally { raw.fill(0); chunks.forEach((chunk) => chunk.fill(0)); }
          });
        });
        request.setTimeout(timeoutMilliseconds, () => request.destroy(unavailable()));
        request.once("error", () => reject(unavailable()));
        if (encoded) request.end(encoded); else request.end();
      });
    } finally { encoded?.fill(0); }
  }
}

export class TrustedMediaCastingRuntimeClient {
  #origin; #ca; #cert; #key; #serverName; #transport; #timeout; #closed = false;
  #wire = Promise.resolve(); #reads = new Map(); #controllers = new Set();

  constructor({ origin, ca, cert, key, serverName, transport = new NodeMtlsCastingTransport(),
    timeoutMilliseconds = 10_000 } = {}) {
    this.#origin = runtimeOrigin(origin);
    if (typeof serverName !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(serverName)
      || isIP(serverName) !== 0) invalid("trusted media TLS server name is invalid");
    if (!transport?.request || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 30_000) {
      invalid("trusted media runtime client configuration is invalid");
    }
    this.#ca = pem(ca, "trusted media CA", /-----BEGIN CERTIFICATE-----/);
    this.#cert = pem(cert, "trusted media client certificate", /-----BEGIN CERTIFICATE-----/);
    this.#key = pem(key, "trusted media client private key", /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/);
    this.#serverName = serverName;
    this.#transport = transport;
    this.#timeout = timeoutMilliseconds;
  }

  async startReceiver(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    if (!RECEIVER_NAME.test(value?.receiverName ?? "") || typeof value?.pairingPin !== "string"
      || value.pairingPin.length !== 4 || !/^[1-9][0-9]{3}$/.test(value.pairingPin)
      || typeof value?.browserStartsMuted !== "boolean"
      || !plain(value?.mediaPrivacyPolicy)) invalid("trusted media receiver start request is invalid");
    return this.#mutation("POST", "/internal/v1/runtime/sessions", {
      sessionId, receiverName: value.receiverName, pairingPin: value.pairingPin,
      outputSinks: outputSinks(value.outputSinks),
      browserStartsMuted: value.browserStartsMuted, mediaPrivacyPolicy: value.mediaPrivacyPolicy,
      expiresAt: canonicalExpiry(value.expiresAt),
    });
  }

  async updateReceiver(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    if (typeof value?.browserStartsMuted !== "boolean" || !plain(value?.mediaPrivacyPolicy)) {
      invalid("trusted media receiver update request is invalid");
    }
    return this.#mutation("PATCH", `/internal/v1/runtime/sessions/${sessionId}`, {
      sessionId, outputSinks: outputSinks(value.outputSinks), browserStartsMuted: value.browserStartsMuted,
      mediaPrivacyPolicy: value.mediaPrivacyPolicy,
    });
  }

  async stopReceiver(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    if (typeof value?.reasonCode !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.reasonCode)) {
      invalid("trusted media receiver stop request is invalid");
    }
    return this.#mutation("DELETE", `/internal/v1/runtime/sessions/${sessionId}`, {
      sessionId, reasonCode: value.reasonCode,
    });
  }

  async issueViewerConnection(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    const viewerIdentityId = uuid(value?.viewerIdentityId, "viewer identity");
    const grantId = uuid(value?.grantId, "viewer grant identity");
    if (!Number.isSafeInteger(value?.audienceRevision) || value.audienceRevision < 1
      || !BROWSER_INSTANCE.test(value?.browserInstanceId ?? "") || typeof value?.muted !== "boolean"
      || value?.maximumViewers !== null && (!Number.isSafeInteger(value?.maximumViewers) || value.maximumViewers < 1)
      || value?.publisherEncodeRenditions !== 1) {
      invalid("trusted media viewer connection request is invalid");
    }
    const response = await this.#call("POST", `/internal/v1/runtime/sessions/${sessionId}/viewer-connections`, {
      sessionId, viewerIdentityId, grantId, audienceRevision: value.audienceRevision,
      browserInstanceId: value.browserInstanceId, expiresAt: canonicalExpiry(value.expiresAt),
      muted: value.muted, maximumViewers: value.maximumViewers, publisherEncodeRenditions: 1,
    });
    if (!plain(response)) throw unavailable();
    return response;
  }

  async consumeViewerConnection(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    const viewerIdentityId = uuid(value?.viewerIdentityId, "viewer identity");
    if (!BROWSER_INSTANCE.test(value?.browserInstanceId ?? "") || typeof value?.accessToken !== "string"
      || value.accessToken.length > 12_288 || !/^[A-Za-z0-9_.-]+$/.test(value.accessToken)) {
      invalid("trusted media viewer admission request is invalid");
    }
    const response = await this.#call("POST", `/internal/v1/runtime/sessions/${sessionId}/viewer-connections/consume`, {
      sessionId, viewerIdentityId, browserInstanceId: value.browserInstanceId, accessToken: value.accessToken,
    });
    if (!plain(response) || response.sessionId !== sessionId || response.viewerIdentityId !== viewerIdentityId
      || !UUID.test(response.grantId ?? "") || !/^cast-[a-f0-9]{32}$/.test(response.participantIdentity ?? "")) throw unavailable();
    return Object.freeze({ sessionId, viewerIdentityId, grantId: response.grantId,
      participantIdentity: response.participantIdentity });
  }

  async disconnectViewer(value) {
    const sessionId = uuid(value?.sessionId, "casting session identity");
    const viewerIdentityId = uuid(value?.viewerIdentityId, "viewer identity");
    if (typeof value?.reasonCode !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.reasonCode)) {
      invalid("trusted media viewer disconnect request is invalid");
    }
    if (value.browserInstanceId !== undefined) {
      if (typeof value.browserInstanceId !== "string" || !BROWSER_INSTANCE.test(value.browserInstanceId)) {
        invalid("trusted media browser context is invalid");
      }
      const response = await this.#call("DELETE",
        `/internal/v1/runtime/sessions/${sessionId}/viewers/${viewerIdentityId}`,
        { sessionId, viewerIdentityId, browserInstanceId: value.browserInstanceId, reasonCode: value.reasonCode });
      if (!plain(response) || !Number.isSafeInteger(response.remainingBrowserConnections)
        || response.remainingBrowserConnections < 0) throw unavailable();
      return Object.freeze({ remainingBrowserConnections: response.remainingBrowserConnections });
    }
    return this.#mutation("DELETE",
      `/internal/v1/runtime/sessions/${sessionId}/viewers/${viewerIdentityId}`,
      { sessionId, viewerIdentityId, reasonCode: value.reasonCode });
  }

  async health({ sessionId } = {}) {
    const normalized = uuid(sessionId, "casting session identity");
    const response = await this.#call("GET", `/internal/v1/runtime/sessions/${normalized}/health`, null, Math.min(this.#timeout, 3000));
    if (!plain(response) || typeof response.healthy !== "boolean" || !plain(response.outputs)) throw unavailable();
    return response;
  }

  async readiness({ nodeId, nodeGeneration } = {}) {
    const expected = uuid(nodeId, "casting node identity");
    if (!Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) invalid("casting node generation is invalid");
    const started = performance.now();
    const response = await this.#call("GET", "/internal/v1/runtime/readiness", null, Math.min(this.#timeout, 4000));
    const keys = (value, names) => plain(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
    const codes = new Set(["cast_media_runtime_unavailable", "cast_sfu_unavailable"]);
    if (performance.now() - started > 5_000 || !keys(response, ["nodeId", "nodeGeneration", "observedAt", "outputs"])
      || response.nodeId !== expected || response.nodeGeneration !== nodeGeneration
      || typeof response.observedAt !== "string" || !Number.isFinite(Date.parse(response.observedAt))
      || Math.abs(Date.now() - Date.parse(response.observedAt)) > 5_000
      || !keys(response.outputs, ["browser"])) throw unavailable();
    for (const sink of ["browser"]) {
      const output = response.outputs[sink];
      if (!keys(output, ["available", "reasonCode"]) || typeof output.available !== "boolean"
        || (output.available ? output.reasonCode !== null : !codes.has(output.reasonCode))) throw unavailable();
    }
    return Object.freeze(structuredClone(response));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#reads.clear();
    this.#ca.fill(0); this.#cert.fill(0); this.#key.fill(0);
  }

  async #mutation(method, path, body) {
    await this.#call(method, path, body);
  }

  async #call(method, path, body, timeoutMilliseconds = this.#timeout) {
    if (this.#closed) throw unavailable();
    // There is one media controller, not one per browser. Coalesce only
    // overlapping reads (no cached health), and invalidate them across a
    // mutation so a later query cannot inherit a pre-mutation observation.
    if (method !== "GET") this.#reads.clear();
    else if (this.#reads.has(path)) return structuredClone(await this.#reads.get(path));
    const operation = this.#queuedCall(method, path, body, timeoutMilliseconds);
    if (method === "GET") this.#reads.set(path, operation);
    try {
      const response = await operation;
      return method === "GET" ? structuredClone(response) : response;
    } finally {
      if (this.#reads.get(path) === operation) this.#reads.delete(path);
    }
  }

  async #queuedCall(method, path, body, timeoutMilliseconds) {
    let response, timer;
    const controller = new AbortController();
    const expiresAt = performance.now() + timeoutMilliseconds;
    this.#controllers.add(controller);
    const previous = this.#wire;
    let operation;
    try {
      // A socket inactivity timer can be extended by partial replies. Bound
      // total time as well; a lost mutation ACK never releases its reservation.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMilliseconds);
      });
      const send = previous.then(() => {
        if (this.#closed || controller.signal.aborted || performance.now() >= expiresAt) throw unavailable();
        return this.#transport.request({ origin: this.#origin, path, method, body,
          ca: this.#ca, cert: this.#cert, key: this.#key, serverName: this.#serverName,
          timeoutMilliseconds, signal: controller.signal });
      });
      operation = Promise.race([deadline, send]);
      // A queued timeout must not release the next request ahead of the
      // preceding wire operation. Expired mutations are skipped, never sent
      // later or retried. The original total deadline includes queue time.
      this.#wire = previous.then(() => operation).catch(() => {});
      response = await operation;
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); this.#controllers.delete(controller); }
    // After a media-process restart its in-memory session is gone. This
    // authenticated, exact health response proves that loss; hiding it as a
    // generic outage leaves the persisted session and reservation stuck.
    // Do not infer termination from transport failures or arbitrary 404s.
    if (method === "GET" && /^\/internal\/v1\/runtime\/sessions\/[0-9a-f-]+\/health$/.test(path)
      && response?.status === 404 && plain(response.body)
      && Object.keys(response.body).join() === "error" && plain(response.body.error)
      && Object.keys(response.body.error).join() === "code"
      && response.body.error.code === "cast_runtime_session_not_found") {
      return { healthy: false, outputs: { browser: { healthy: false } },
        receiverState: "failed", failureCode: "cast_runtime_session_not_found" };
    }
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw unavailable();
    }
    return response.body;
  }
}
