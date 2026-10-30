import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class UnlockError extends Error {
  constructor(code, message, { status = 400, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = "UnlockError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function fail(code, message, options) { throw new UnlockError(code, message, options); }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.has(key))) fail("unlock_request_invalid", "Unlock request is invalid");
  return value;
}

export class UnlockRateLimiter {
  #clock; #maximumFailures; #windowMs; #blockMs; #entries = new Map();
  constructor({ clock = () => new Date(), maximumFailures = 5, windowMilliseconds = 15 * 60_000, blockMilliseconds = 15 * 60_000 } = {}) {
    if (![maximumFailures, windowMilliseconds, blockMilliseconds].every(Number.isSafeInteger) || maximumFailures < 1 || windowMilliseconds < 1_000 || blockMilliseconds < 1_000) throw new TypeError("unlock rate policy is invalid");
    this.#clock = clock; this.#maximumFailures = maximumFailures; this.#windowMs = windowMilliseconds; this.#blockMs = blockMilliseconds;
  }
  #entry(key) {
    const now = this.#clock().getTime();
    const previous = this.#entries.get(key) ?? { failures: [], blockedUntil: 0 };
    previous.failures = previous.failures.filter((value) => now - value < this.#windowMs);
    if (previous.blockedUntil <= now) previous.blockedUntil = 0;
    this.#entries.set(key, previous);
    return { now, value: previous };
  }
  assertAllowed(networkDigest) {
    const { now, value } = this.#entry(networkDigest);
    if (value.blockedUntil > now) fail("unlock_rate_limited", "Unlock attempts are temporarily limited", { status: 429, retryAfterSeconds: Math.ceil((value.blockedUntil - now) / 1000) });
  }
  failure(networkDigest) {
    const { now, value } = this.#entry(networkDigest);
    value.failures.push(now);
    if (value.failures.length >= this.#maximumFailures) value.blockedUntil = now + this.#blockMs;
  }
  success(networkDigest) { this.#entries.delete(networkDigest); }
  status(networkDigest) {
    const { now, value } = this.#entry(networkDigest);
    return Object.freeze({ limited: value.blockedUntil > now, retryAfterSeconds: value.blockedUntil > now ? Math.ceil((value.blockedUntil - now) / 1000) : 0, remainingAttempts: Math.max(0, this.#maximumFailures - value.failures.length) });
  }
}

export class UnlockChallengeStore {
  #clock; #ttl; #entries = new Map();
  constructor({ clock = () => new Date(), ttlMilliseconds = 5 * 60_000 } = {}) {
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 30_000 || ttlMilliseconds > 15 * 60_000) throw new TypeError("unlock challenge TTL is invalid");
    this.#clock = clock; this.#ttl = ttlMilliseconds;
  }
  issue({ networkDigest, origin }) {
    const id = randomBytes(24).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#clock().getTime() + this.#ttl);
    this.#entries.set(id, { tokenDigest: digest(token), networkDigest, origin, expiresAt });
    return Object.freeze({ id, token, expiresAt });
  }
  consume({ id, token, networkDigest, origin }) {
    const value = this.#entries.get(id);
    this.#entries.delete(id);
    if (!value || value.expiresAt <= this.#clock() || value.networkDigest !== networkDigest || value.origin !== origin) fail("unlock_challenge_invalid", "Unlock challenge is invalid", { status: 403 });
    const expected = Buffer.from(value.tokenDigest, "hex");
    const actual = Buffer.from(digest(token), "hex");
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
    expected.fill(0); actual.fill(0);
    if (!valid) fail("unlock_challenge_invalid", "Unlock challenge is invalid", { status: 403 });
  }
}

export class UnlockService {
  #adapter; #audit; #limiter; #clock;
  constructor({ adapter, auditBuffer, rateLimiter = new UnlockRateLimiter(), clock = () => new Date() }) {
    if (!adapter?.status || !adapter?.unlockWithPassphrase || !auditBuffer?.append) throw new TypeError("unlock service dependencies are incomplete");
    this.#adapter = adapter; this.#audit = auditBuffer; this.#limiter = rateLimiter; this.#clock = clock;
  }
  networkDigest(networkIdentifier) {
    if (typeof networkIdentifier !== "string" || networkIdentifier.length < 1 || networkIdentifier.length > 256) fail("unlock_network_invalid", "Unlock network identity is invalid");
    return "sha256:" + digest(networkIdentifier);
  }
  async status({ networkIdentifier, networkStatus }) {
    const networkDigest = this.networkDigest(networkIdentifier);
    const state = await this.#adapter.status();
    if (!state || !new Set(["locked", "unlocking", "unlocked", "error"]).has(state.state)) fail("unlock_state_unavailable", "Unlock state is unavailable", { status: 503 });
    return Object.freeze({ state: state.state, mode: state.mode ?? "web_passphrase", network: networkStatus, rateLimit: this.#limiter.status(networkDigest) });
  }
  async unlock({ request, networkIdentifier, requestId }) {
    exactObject(request, new Set(["passphrase"]));
    const passphrase = request.passphrase;
    if (typeof passphrase !== "string" || passphrase.length < 1 || passphrase.length > 4096 || passphrase.includes("\0")) fail("unlock_request_invalid", "Unlock request is invalid");
    const networkDigest = this.networkDigest(networkIdentifier);
    try {
      this.#limiter.assertAllowed(networkDigest);
    } catch (error) {
      if (error instanceof UnlockError && error.code === "unlock_rate_limited") await this.#audit.append({ timestamp: this.#clock(), action: "unlock.passphrase", outcome: "limited", networkDigest, requestId });
      throw error;
    }
    const bytes = Buffer.from(passphrase, "utf8");
    let result;
    try {
      result = await this.#adapter.unlockWithPassphrase(bytes);
    } catch {
      result = { unlocked: false, reason: "adapter_error" };
    } finally {
      bytes.fill(0);
    }
    if (!result?.unlocked) {
      this.#limiter.failure(networkDigest);
      const limit = this.#limiter.status(networkDigest);
      await this.#audit.append({ timestamp: this.#clock(), action: "unlock.passphrase", outcome: "denied", networkDigest, requestId });
      fail(limit.limited ? "unlock_rate_limited" : "unlock_denied", limit.limited ? "Unlock attempts are temporarily limited" : "Unlock failed", { status: limit.limited ? 429 : 401, retryAfterSeconds: limit.retryAfterSeconds || null });
    }
    this.#limiter.success(networkDigest);
    await this.#audit.append({ timestamp: this.#clock(), action: "unlock.passphrase", outcome: "accepted", networkDigest, requestId });
    return Object.freeze({ state: "unlocking", accepted: true });
  }
}

export { PreUnlockAuditBuffer } from "./pre-unlock-audit-buffer.mjs";
export { UnixUnlockAdapter } from "./unix-unlock-adapter.mjs";
export { UnlockProtectionTransitionService } from "./unlock-protection-transition-service.mjs";
export { MemoryUnlockTransitionRepository } from "./memory-unlock-transition-repository.mjs";
export { PostgresUnlockTransitionRepository } from "./postgres-unlock-transition-repository.mjs";
export { RecoveryLifecycleService, MemoryRecoveryLifecycleRepository } from "./recovery-lifecycle-service.mjs";
