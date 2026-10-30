import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID_PART = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const UUID = new RegExp(`^${UUID_PART}$`, "i");
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PAIR = new RegExp(`^/internal/v1/casting/sessions/${UUID_PART}/source/pair$`, "i");
const STREAMING = new RegExp(`^/internal/v1/casting/sessions/${UUID_PART}/source/streaming$`, "i");
const AUTHORIZE = new RegExp(`^/internal/v1/casting/sessions/${UUID_PART}/viewers/authorize$`, "i");
const EXPECTED_ENDPOINTS = Object.freeze({
  pairSource: Object.freeze({ method: "POST", pathTemplate: "/internal/v1/casting/sessions/{sessionId}/source/pair" }),
  markStreaming: Object.freeze({ method: "POST", pathTemplate: "/internal/v1/casting/sessions/{sessionId}/source/streaming" }),
  authorizeViewer: Object.freeze({ method: "POST", pathTemplate: "/internal/v1/casting/sessions/{sessionId}/viewers/authorize" }),
});

function fail(code, message, status = 400, retryable = false) {
  throw new PlatformError(code, message, { status, retryable });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function oneHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

function contractError(message) {
  throw new TypeError(`trusted media callback contract is invalid: ${message}`);
}

export function validateTrustedMediaCallbackContract(contract, { requireRuntimeBinding = false } = {}) {
  if (!plainObject(contract) || contract.schemaVersion !== 1
    || contract.contractId !== "teamaibox.trusted-media-callback.v1") contractError("identity");
  const exposure = contract.exposure;
  if (!exactKeys(exposure, ["listener", "minimumTlsVersion", "maximumRequestBytes",
    "sharedBrowserListenerAllowed", "publicRouteAllowed"])
    || exposure.listener !== "dedicated-private-mtls"
    || exposure.minimumTlsVersion !== "TLSv1.3"
    || exposure.sharedBrowserListenerAllowed !== false || exposure.publicRouteAllowed !== false
    || !Number.isSafeInteger(exposure.maximumRequestBytes)
    || exposure.maximumRequestBytes < 1024 || exposure.maximumRequestBytes > 65_536) {
    contractError("private listener boundary");
  }
  const identity = contract.serviceIdentity;
  if (!exactKeys(identity, ["serviceIdentityId", "spiffeUri", "certificateFingerprint",
    "forwardedIdentityHeadersAccepted"])
    || !UUID.test(identity.serviceIdentityId ?? "")
    || identity.spiffeUri !== `spiffe://teamaibox.local/service/trusted-media/${identity.serviceIdentityId.toLowerCase()}`
    || identity.forwardedIdentityHeadersAccepted !== false
    || (identity.certificateFingerprint !== null && !SHA256.test(identity.certificateFingerprint))) {
    contractError("service identity binding");
  }
  const replay = contract.replay;
  if (!exactKeys(replay, ["callbackIdHeader", "issuedAtHeader", "maximumClockSkewSeconds",
    "retentionSeconds", "maximumEntries", "reusedCallbackIdPolicy"])
    || replay.callbackIdHeader !== "x-teamaibox-callback-id"
    || replay.issuedAtHeader !== "x-teamaibox-callback-issued-at"
    || replay.reusedCallbackIdPolicy !== "reject"
    || !Number.isSafeInteger(replay.maximumClockSkewSeconds) || replay.maximumClockSkewSeconds < 5
    || replay.maximumClockSkewSeconds > 60
    || !Number.isSafeInteger(replay.retentionSeconds)
    || replay.retentionSeconds < replay.maximumClockSkewSeconds * 2 || replay.retentionSeconds > 300
    || !Number.isSafeInteger(replay.maximumEntries) || replay.maximumEntries < 128
    || replay.maximumEntries > 65_536) contractError("replay boundary");
  if (!exactKeys(contract.endpoints, Object.keys(EXPECTED_ENDPOINTS))) contractError("endpoint set");
  for (const [name, expected] of Object.entries(EXPECTED_ENDPOINTS)) {
    if (!exactKeys(contract.endpoints[name], ["method", "pathTemplate"])
      || contract.endpoints[name].method !== expected.method
      || contract.endpoints[name].pathTemplate !== expected.pathTemplate) contractError(`endpoint ${name}`);
  }
  const authorization = contract.viewerAuthorization;
  if (!exactKeys(authorization, ["maximumCredentialTtlSeconds", "permission", "currentAudienceRequired",
    "joinedCurrentGrantRequired", "browserInstanceBindingRequired", "recheckOnEveryConnection",
    "maximumViewers", "publisherEncodeRenditions"])
    || authorization.maximumCredentialTtlSeconds !== 300 || authorization.permission !== "cast:view"
    || authorization.currentAudienceRequired !== true || authorization.joinedCurrentGrantRequired !== true
    || authorization.browserInstanceBindingRequired !== true || authorization.recheckOnEveryConnection !== true
    || authorization.maximumViewers !== null && (!Number.isSafeInteger(authorization.maximumViewers) || authorization.maximumViewers < 1)
    || authorization.publisherEncodeRenditions !== 1) {
    contractError("viewer authorization boundary");
  }
  const secrets = contract.secretBoundary;
  if (!exactKeys(secrets, ["pairingPinPersisted", "mediaCredentialPersisted", "requestBodiesLogged",
    "callbackBodiesInAudit", "replayStateFields"])
    || secrets.pairingPinPersisted !== false || secrets.mediaCredentialPersisted !== false
    || secrets.requestBodiesLogged !== false || secrets.callbackBodiesInAudit !== false
    || JSON.stringify(secrets.replayStateFields) !== JSON.stringify(["callbackId", "expiresAt"])) {
    contractError("secret handling boundary");
  }
  const runtimeBound = contract.status === "runtime-bound"
    && identity.certificateFingerprint !== null
    && contract.activationGate?.bound === true
    && Array.isArray(contract.activationGate?.blockers) && contract.activationGate.blockers.length === 0;
  const blocked = contract.status === "contract-ready-activation-blocked"
    && identity.certificateFingerprint === null
    && contract.activationGate?.bound === false
    && Array.isArray(contract.activationGate?.blockers) && contract.activationGate.blockers.length > 0;
  if (!runtimeBound && !blocked) contractError("activation state");
  const claims = contract.claimBoundary;
  if (!exactKeys(claims, ["sourceContractReady", "runtimeBound", "deploymentPerformed",
    "receiverOrMediaStarted", "realAppleSenderAccepted", "realBrowserWebrtcAccepted",
    "task22_6Complete", "task22_7Complete"])
    || claims.sourceContractReady !== true || claims.runtimeBound !== runtimeBound
    || claims.deploymentPerformed !== false || claims.receiverOrMediaStarted !== false
    || claims.realAppleSenderAccepted !== false || claims.realBrowserWebrtcAccepted !== false
    || claims.task22_6Complete !== false || claims.task22_7Complete !== false) {
    contractError("claim boundary");
  }
  if (requireRuntimeBinding && !runtimeBound) contractError("runtime certificate is not bound");
  return Object.freeze({ contractId: contract.contractId, runtimeBound,
    maximumRequestBytes: exposure.maximumRequestBytes,
    serviceIdentityId: identity.serviceIdentityId.toLowerCase(),
    certificateFingerprint: identity.certificateFingerprint,
    callbackIdHeader: replay.callbackIdHeader, issuedAtHeader: replay.issuedAtHeader,
    maximumClockSkewMilliseconds: replay.maximumClockSkewSeconds * 1000,
    retentionMilliseconds: replay.retentionSeconds * 1000,
    maximumEntries: replay.maximumEntries });
}

/**
 * Derive service identity only from an authorized TLS socket. Forwarded client
 * certificate headers are deliberately ignored so the browser/public proxy can
 * never manufacture this internal caller identity.
 */
export function trustedMediaTransportIdentity(request) {
  const socket = request?.socket;
  if (socket?.encrypted !== true || socket.authorized !== true
    || typeof socket.getPeerCertificate !== "function") {
    fail("cast_callback_mtls_required", "Verified trusted media mutual TLS is required", 401);
  }
  const certificate = socket.getPeerCertificate(false);
  const san = String(certificate?.subjectaltname ?? "");
  const matches = [...san.matchAll(/(?:^|,\s*)URI:spiffe:\/\/teamaibox\.local\/service\/trusted-media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=,|$)/gi)];
  const fingerprintHex = String(certificate?.fingerprint256 ?? "").replaceAll(":", "").toLowerCase();
  if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(fingerprintHex)) {
    fail("cast_callback_certificate_rejected", "Trusted media certificate identity is invalid", 401);
  }
  return Object.freeze({ mutualTls: true, certificateVerified: true,
    subjectServiceIdentityId: matches[0][1].toLowerCase(),
    certificateFingerprint: `sha256:${fingerprintHex}` });
}

export function matchesTrustedMediaCallbackRoute(method, pathname) {
  return method === "POST" && (PAIR.test(pathname) || STREAMING.test(pathname) || AUTHORIZE.test(pathname));
}

export class TrustedMediaCallbackHttpApi {
  #service;
  #contract;
  #clock;
  #replay = new Map();

  constructor({ service, contract, clock = () => new Date() } = {}) {
    if (!["pairSource", "markStreaming", "authorizeMediaConnection"]
      .every((method) => typeof service?.[method] === "function") || typeof clock !== "function") {
      throw new TypeError("trusted media callback API dependencies are incomplete");
    }
    this.#service = service;
    this.#contract = validateTrustedMediaCallbackContract(contract, { requireRuntimeBinding: true });
    this.#clock = clock;
  }

  matches(method, pathname) { return matchesTrustedMediaCallbackRoute(method, pathname); }

  maximumRequestBytes() { return this.#contract.maximumRequestBytes; }

  close() { this.#replay.clear(); }

  async handle({ method, pathname, body, headers = {}, transportIdentity } = {}) {
    if (!this.matches(method, pathname)) fail("not_found", "Trusted media callback was not found", 404);
    this.#authorizeTransport(transportIdentity);
    this.#claimCallback(headers);

    const pair = PAIR.exec(pathname);
    if (pair) {
      if (!exactKeys(body, ["pin", "source_connection_id"], ["source_device_label"])) {
        fail("cast_callback_invalid", "Trusted media callback body is invalid");
      }
      const result = await this.#service.pairSource({ sessionId: pair[1].toLowerCase(), pin: body.pin,
        sourceConnectionId: body.source_connection_id, sourceDeviceLabel: body.source_device_label ?? null });
      return { kind: "json", status: 200, body: { paired: result.paired === true,
        repeated: result.repeated === true, blocked: result.blocked === true,
        state: result.state ?? null, failed_attempts: result.failedAttempts ?? 0,
        blocked_until: result.blockedUntil ?? null } };
    }
    const streaming = STREAMING.exec(pathname);
    if (streaming) {
      if (!exactKeys(body, ["source_connection_id"])) {
        fail("cast_callback_invalid", "Trusted media callback body is invalid");
      }
      const result = await this.#service.markStreaming({ sessionId: streaming[1].toLowerCase(),
        sourceConnectionId: body.source_connection_id });
      return { kind: "json", status: 200, body: { session_id: result.sessionId,
        state: result.state, state_revision: result.stateRevision } };
    }
    const authorize = AUTHORIZE.exec(pathname);
    if (!exactKeys(body, ["viewer_identity_id", "browser_instance_id", "media_credential"])) {
      fail("cast_callback_invalid", "Trusted media callback body is invalid");
    }
    const result = await this.#service.authorizeMediaConnection({ sessionId: authorize[1].toLowerCase(),
      viewerIdentityId: body.viewer_identity_id, browserInstanceId: body.browser_instance_id,
      mediaCredential: body.media_credential });
    return { kind: "json", status: 200, body: { authorized: true, session_id: result.sessionId,
      viewer_identity_id: result.viewerIdentityId, grant_id: result.grantId,
      audience_revision: result.audienceRevision, expires_at: result.expiresAt, muted: result.muted,
      maximum_viewers: result.maximumViewers,
      publisher_encode_renditions: result.publisherEncodeRenditions } };
  }

  #authorizeTransport(value) {
    if (value?.mutualTls !== true || value?.certificateVerified !== true
      || value?.subjectServiceIdentityId !== this.#contract.serviceIdentityId
      || value?.certificateFingerprint !== this.#contract.certificateFingerprint) {
      fail("cast_callback_mtls_required", "Verified trusted media mutual TLS is required", 401);
    }
  }

  #claimCallback(headers) {
    const now = this.#clock();
    const callbackId = oneHeader(headers, this.#contract.callbackIdHeader);
    const issuedAt = canonicalTimestamp(oneHeader(headers, this.#contract.issuedAtHeader));
    if (!UUID.test(callbackId ?? "") || !issuedAt
      || Math.abs(now.getTime() - issuedAt.getTime()) > this.#contract.maximumClockSkewMilliseconds) {
      fail("cast_callback_stale", "Trusted media callback is stale or malformed", 401);
    }
    for (const [id, expiresAt] of this.#replay) {
      if (expiresAt <= now.getTime()) this.#replay.delete(id);
    }
    if (this.#replay.has(callbackId)) {
      fail("cast_callback_replayed", "Trusted media callback ID was already used", 409);
    }
    if (this.#replay.size >= this.#contract.maximumEntries) {
      fail("cast_callback_replay_capacity", "Trusted media callback replay guard is full", 503, true);
    }
    // Only public callback identity and expiry are retained. Request bodies,
    // pairing PINs and media credentials never enter replay state.
    this.#replay.set(callbackId, now.getTime() + this.#contract.retentionMilliseconds);
  }
}
