import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROWSER_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SOURCE_CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const PAIRING_PIN = /^[1-9][0-9]{3}$/;
const MEDIA_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

function fail(code, message, status = 400, retryable = false) {
  throw new PlatformError(code, message, { status, retryable });
}

function digest(salt, value) {
  return createHash("sha256").update(salt).update("\0").update(value).digest();
}

function secureRandomBytes(factory, length, label) {
  const value = factory(length);
  if (!Buffer.isBuffer(value) || value.byteLength !== length) {
    value?.fill?.(0);
    throw new TypeError(`casting ${label} entropy is invalid`);
  }
  return value;
}

function clear(record) {
  record.pin?.fill(0);
  record.pinSalt?.fill(0);
  record.pinDigest?.fill(0);
  for (const credential of record.credentials.values()) {
    credential.digest.fill(0);
    credential.salt.fill(0);
  }
  record.credentials.clear();
  record.sourceConnectionId = null;
  record.sourceDeviceLabel = null;
}

/**
 * Process-local casting secrets.  The repository intentionally has no
 * serialization hook: pairing material and browser media credentials die with
 * the process and can never be written to PostgreSQL, logs, the bus, backups,
 * or acceptance evidence through this abstraction.
 */
export class MemoryCastingEphemeralStore {
  #sessions = new Map();
  #clock;
  #randomBytes;
  #randomInt;
  #pairingFailureLimit;
  #pairingBlockMilliseconds;

  constructor({
    clock = () => new Date(),
    randomBytesFactory = randomBytes,
    randomIntFactory = randomInt,
    pairingFailureLimit = 5,
    pairingBlockMilliseconds = 60_000,
  } = {}) {
    if (typeof clock !== "function" || typeof randomBytesFactory !== "function"
      || typeof randomIntFactory !== "function"
      || !Number.isSafeInteger(pairingFailureLimit) || pairingFailureLimit < 3 || pairingFailureLimit > 10
      || !Number.isSafeInteger(pairingBlockMilliseconds) || pairingBlockMilliseconds < 1_000
      || pairingBlockMilliseconds > 15 * 60_000) {
      throw new TypeError("casting ephemeral store policy is invalid");
    }
    this.#clock = clock;
    this.#randomBytes = randomBytesFactory;
    this.#randomInt = randomIntFactory;
    this.#pairingFailureLimit = pairingFailureLimit;
    this.#pairingBlockMilliseconds = pairingBlockMilliseconds;
  }

  createSession({ sessionId, expiresAt }) {
    if (!UUID.test(sessionId ?? "")) throw new TypeError("casting session id is invalid");
    const expiry = new Date(expiresAt);
    const now = this.#clock();
    if (!Number.isFinite(expiry.getTime()) || expiry <= now || this.#sessions.has(sessionId)) {
      throw new TypeError("casting ephemeral session is invalid");
    }
    const receiverEntropy = secureRandomBytes(this.#randomBytes, 5, "receiver-name");
    const receiverName = `Team-AI-${receiverEntropy.toString("hex").toUpperCase()}`;
    receiverEntropy.fill(0);
    // Match the native AirPlay receiver's four-digit PIN envelope, using
    // conventional non-leading-zero codes and the existing attempt limit.
    const pinValue = this.#randomInt(1000, 10_000);
    if (!Number.isSafeInteger(pinValue) || pinValue < 1000 || pinValue >= 10_000) {
      throw new TypeError("casting pairing PIN entropy is invalid");
    }
    const pin = Buffer.from(String(pinValue), "utf8");
    let pinSalt;
    try {
      pinSalt = secureRandomBytes(this.#randomBytes, 32, "pairing-PIN");
    } catch (error) {
      pin.fill(0);
      throw error;
    }
    const record = {
      receiverName,
      pin,
      pinSalt,
      pinDigest: digest(pinSalt, pin),
      expiresAt: expiry,
      failedAttempts: 0,
      blockedUntil: null,
      sourceConnectionId: null,
      sourceDeviceLabel: null,
      credentials: new Map(),
    };
    this.#sessions.set(sessionId, record);
    return Object.freeze({ receiverName, pin: pin.toString("utf8"), expiresAt: expiry.toISOString() });
  }

  describe(sessionId) {
    const value = this.#active(sessionId, false);
    if (!value) return null;
    return Object.freeze({
      receiverName: value.receiverName,
      pin: value.pin.toString("utf8"),
      sourceDeviceLabel: value.sourceDeviceLabel,
      sourcePaired: value.sourceConnectionId !== null,
      expiresAt: value.expiresAt.toISOString(),
    });
  }

  verifyAndPair({ sessionId, pin, sourceConnectionId, sourceDeviceLabel = null }) {
    const value = this.#active(sessionId);
    const now = this.#clock();
    if (value.blockedUntil && value.blockedUntil > now) {
      return Object.freeze({ paired: false, blocked: true, failedAttempts: value.failedAttempts,
        blockedUntil: value.blockedUntil.toISOString() });
    }
    if (!SOURCE_CONNECTION.test(sourceConnectionId ?? "")
      || (sourceDeviceLabel !== null && (typeof sourceDeviceLabel !== "string"
        || [...sourceDeviceLabel].length < 1 || [...sourceDeviceLabel].length > 128
        || /[\u0000-\u001f\u007f]/u.test(sourceDeviceLabel)))) {
      fail("cast_source_invalid", "Casting source is invalid");
    }
    if (value.sourceConnectionId !== null) {
      if (value.sourceConnectionId === sourceConnectionId) {
        return Object.freeze({ paired: true, repeated: true, failedAttempts: value.failedAttempts, blockedUntil: null });
      }
      fail("cast_source_busy", "A casting source is already paired", 409);
    }
    const candidate = Buffer.from(PAIRING_PIN.test(pin ?? "") ? pin : "", "utf8");
    const actual = digest(value.pinSalt, candidate);
    const valid = candidate.byteLength === value.pin.byteLength
      && actual.byteLength === value.pinDigest.byteLength
      && timingSafeEqual(actual, value.pinDigest);
    candidate.fill(0);
    actual.fill(0);
    if (!valid) {
      value.failedAttempts = Math.min(10, value.failedAttempts + 1);
      if (value.failedAttempts >= this.#pairingFailureLimit) {
        value.blockedUntil = new Date(Math.min(
          value.expiresAt.getTime(),
          now.getTime() + this.#pairingBlockMilliseconds,
        ));
      }
      return Object.freeze({ paired: false, blocked: value.blockedUntil !== null,
        failedAttempts: value.failedAttempts, blockedUntil: value.blockedUntil?.toISOString() ?? null });
    }
    value.sourceConnectionId = sourceConnectionId;
    value.sourceDeviceLabel = sourceDeviceLabel;
    value.blockedUntil = null;
    return Object.freeze({ paired: true, repeated: false, failedAttempts: value.failedAttempts, blockedUntil: null });
  }

  verifySourceConnection({ sessionId, sourceConnectionId }) {
    const value = this.#active(sessionId, false);
    return value !== null
      && SOURCE_CONNECTION.test(sourceConnectionId ?? "")
      && value.sourceConnectionId === sourceConnectionId;
  }

  issueViewerCredential({ sessionId, viewerIdentityId, browserInstanceId, expiresAt }) {
    const value = this.#active(sessionId);
    if (!UUID.test(viewerIdentityId ?? "") || !BROWSER_INSTANCE.test(browserInstanceId ?? "")) {
      fail("cast_viewer_context_invalid", "Casting viewer context is invalid");
    }
    const expiry = new Date(expiresAt), now = this.#clock();
    if (!Number.isFinite(expiry.getTime()) || expiry <= now || expiry > value.expiresAt) {
      fail("cast_viewer_credential_ttl_invalid", "Casting viewer credential lifetime is invalid");
    }
    // Replacing this browser's entry secret must not invalidate another tab
    // belonging to the same viewer. Authority revocation still clears all of
    // that viewer's browser secrets through revokeViewer below.
    const key = `${viewerIdentityId}\0${browserInstanceId}`;
    for (const [existingKey, existing] of value.credentials) {
      if (existingKey === key || existing.expiresAt <= now) {
        existing.digest.fill(0);
        existing.salt.fill(0);
        value.credentials.delete(existingKey);
      }
    }
    const secret = secureRandomBytes(this.#randomBytes, 32, "viewer-credential");
    const token = secret.toString("base64url");
    secret.fill(0);
    const salt = secureRandomBytes(this.#randomBytes, 32, "viewer-credential-salt");
    value.credentials.set(key, {
      viewerIdentityId,
      browserInstanceId,
      salt,
      digest: digest(salt, token),
      expiresAt: expiry,
    });
    return Object.freeze({ mediaCredential: token, expiresAt: expiry.toISOString() });
  }

  verifyViewerCredential({ sessionId, viewerIdentityId, browserInstanceId, mediaCredential }) {
    const session = this.#active(sessionId, false);
    const value = session?.credentials.get(`${viewerIdentityId}\0${browserInstanceId}`);
    if (!value || value.expiresAt <= this.#clock() || value.browserInstanceId !== browserInstanceId
      || !MEDIA_CREDENTIAL.test(mediaCredential ?? "")) return false;
    const actual = digest(value.salt, mediaCredential);
    const valid = actual.byteLength === value.digest.byteLength && timingSafeEqual(actual, value.digest);
    actual.fill(0);
    return valid;
  }

  hasViewerCredentials({ sessionId, viewerIdentityId }) {
    const session = this.#active(sessionId, false), now = this.#clock();
    return Boolean(session && [...session.credentials.values()].some(value =>
      value.viewerIdentityId === viewerIdentityId && !value.admitted && value.expiresAt > now));
  }

  markViewerCredentialAdmitted(input) {
    if (!this.verifyViewerCredential(input)) return false;
    const session = this.#active(input.sessionId, false);
    const value = session?.credentials.get(`${input.viewerIdentityId}\0${input.browserInstanceId}`);
    if (!value) return false;
    // Only an unused entry may protect a page that is still joining. An
    // admitted page is represented by its actual runtime connection, even
    // if the browser cancels pagehide HTTP cleanup while closing.
    value.admitted = true;
    return true;
  }

  revokeViewer({ sessionId, viewerIdentityId, browserInstanceId }) {
    if (browserInstanceId !== undefined && (typeof browserInstanceId !== "string" || !BROWSER_INSTANCE.test(browserInstanceId))) {
      fail("cast_viewer_context_invalid", "Casting viewer context is invalid");
    }
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    let revoked = false;
    for (const [key, value] of session.credentials) {
      if (value.viewerIdentityId !== viewerIdentityId) continue;
      if (browserInstanceId !== undefined && value.browserInstanceId !== browserInstanceId) continue;
      value.digest.fill(0);
      value.salt.fill(0);
      session.credentials.delete(key);
      revoked = true;
    }
    return revoked;
  }

  revokeAllExcept({ sessionId, viewerIdentityId }) {
    const session = this.#sessions.get(sessionId);
    if (!session) return 0;
    let revoked = 0;
    for (const identityId of new Set([...session.credentials.values()].map(value => value.viewerIdentityId))) {
      if (identityId !== viewerIdentityId && this.revokeViewer({ sessionId, viewerIdentityId: identityId })) revoked += 1;
    }
    return revoked;
  }

  destroySession(sessionId) {
    const value = this.#sessions.get(sessionId);
    if (!value) return false;
    clear(value);
    this.#sessions.delete(sessionId);
    return true;
  }

  close() {
    for (const sessionId of [...this.#sessions.keys()]) this.destroySession(sessionId);
  }

  #active(sessionId, required = true) {
    const value = this.#sessions.get(sessionId);
    if (value && value.expiresAt <= this.#clock()) {
      this.destroySession(sessionId);
      if (!required) return null;
      fail("cast_session_expired", "Casting session has expired", 410);
    }
    if (!value && required) fail("cast_receiver_state_unavailable", "Casting receiver state is unavailable", 409);
    return value ?? null;
  }
}
