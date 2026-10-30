import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PROOF = /^taib-owner-recovery-v1\.([0-9]{10,13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const KEY = /^[A-Za-z0-9_-]{43,171}$/;
const DOMAIN = "teamaibox.owner-recovery.v1";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function keyBytes(value) {
  if (typeof value !== "string" || !KEY.test(value)) {
    throw new TypeError("owner recovery proof key must be protected base64url material");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 32 || bytes.length > 128 || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    throw new TypeError("owner recovery proof key must be protected base64url material");
  }
  return bytes;
}

function proofPayload(challenge, issuedAt, nonce) {
  return `${DOMAIN}\0${challenge}\0${issuedAt}\0${nonce}`;
}

export class OwnerRecoveryAuthorityError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "OwnerRecoveryAuthorityError";
    this.code = code;
    this.status = status;
  }
}

export class OwnerRecoveryProofAuthority {
  #key;
  #clock;
  #challengeTtlMs;
  #proofTtlMs;
  #futureSkewMs;
  #maximumChallenges;
  #networkChallengeLimit;
  #networkWindowMs;
  #challenges = new Map();
  #networkIssues = new Map();
  #closed = false;

  static async fromFile(path, options = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("PLATFORM_OWNER_RECOVERY_KEY_FILE must be an absolute path");
    }
    const raw = await readFile(path);
    try {
      return new OwnerRecoveryProofAuthority(raw.toString("utf8").trim(), options);
    } finally {
      raw.fill(0);
    }
  }

  constructor(key, {
    clock = () => new Date(),
    challengeTtlMs = 5 * 60 * 1000,
    proofTtlMs = 5 * 60 * 1000,
    futureSkewMs = 30 * 1000,
    maximumChallenges = 256,
    networkChallengeLimit = 5,
    networkWindowMs = 15 * 60 * 1000,
  } = {}) {
    this.#key = keyBytes(key);
    this.#clock = clock;
    this.#challengeTtlMs = challengeTtlMs;
    this.#proofTtlMs = proofTtlMs;
    this.#futureSkewMs = futureSkewMs;
    this.#maximumChallenges = maximumChallenges;
    this.#networkChallengeLimit = networkChallengeLimit;
    this.#networkWindowMs = networkWindowMs;
  }

  #clean(nowMs) {
    for (const [challenge, state] of this.#challenges) {
      if (state.expiresAtMs <= nowMs) this.#challenges.delete(challenge);
    }
    for (const [networkHash, timestamps] of this.#networkIssues) {
      const fresh = timestamps.filter((value) => value > nowMs - this.#networkWindowMs);
      if (fresh.length) this.#networkIssues.set(networkHash, fresh);
      else this.#networkIssues.delete(networkHash);
    }
  }

  createChallenge({ networkIdentifier = "unknown" } = {}) {
    if (this.#closed) throw new OwnerRecoveryAuthorityError("recovery_unavailable", "Owner recovery is unavailable", 503);
    const now = this.#clock();
    const nowMs = now.getTime();
    this.#clean(nowMs);
    const networkHash = digest(String(networkIdentifier).slice(0, 256));
    const issued = this.#networkIssues.get(networkHash) ?? [];
    if (issued.length >= this.#networkChallengeLimit) {
      throw new OwnerRecoveryAuthorityError("recovery_throttled", "Too many owner recovery attempts", 429);
    }
    if (this.#challenges.size >= this.#maximumChallenges) {
      throw new OwnerRecoveryAuthorityError("recovery_unavailable", "Owner recovery is temporarily unavailable", 503);
    }
    const challenge = randomBytes(32).toString("base64url");
    const expiresAtMs = nowMs + this.#challengeTtlMs;
    this.#challenges.set(challenge, { expiresAtMs, attempts: 0 });
    this.#networkIssues.set(networkHash, [...issued, nowMs]);
    return Object.freeze({ challenge, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  issueProof(challenge) {
    if (this.#closed || typeof challenge !== "string" || !CHALLENGE.test(challenge)) {
      throw new TypeError("owner recovery challenge is invalid");
    }
    const issuedAt = String(this.#clock().getTime());
    const nonce = randomBytes(16).toString("base64url");
    const signature = createHmac("sha256", this.#key)
      .update(proofPayload(challenge, issuedAt, nonce), "utf8")
      .digest("base64url");
    return `taib-owner-recovery-v1.${issuedAt}.${nonce}.${signature}`;
  }

  async verify(value) {
    if (this.#closed || !value || typeof value !== "object") return false;
    const { challenge, proof } = value;
    if (typeof challenge !== "string" || !CHALLENGE.test(challenge) || typeof proof !== "string") return false;
    const nowMs = this.#clock().getTime();
    this.#clean(nowMs);
    const state = this.#challenges.get(challenge);
    if (!state) return false;
    const match = PROOF.exec(proof);
    let valid = false;
    if (match) {
      const issuedAt = Number(match[1]);
      const expected = createHmac("sha256", this.#key)
        .update(proofPayload(challenge, match[1], match[2]), "utf8")
        .digest();
      const actual = Buffer.from(match[3], "base64url");
      try {
        valid = Number.isSafeInteger(issuedAt)
          && issuedAt <= nowMs + this.#futureSkewMs
          && issuedAt >= nowMs - this.#proofTtlMs
          && actual.length === expected.length
          && timingSafeEqual(actual, expected);
      } finally {
        expected.fill(0);
        actual.fill(0);
      }
    }
    if (valid) this.#challenges.delete(challenge);
    else {
      state.attempts += 1;
      if (state.attempts >= 5) this.#challenges.delete(challenge);
    }
    return valid;
  }

  close() {
    if (this.#closed) return;
    this.#key.fill(0);
    this.#challenges.clear();
    this.#networkIssues.clear();
    this.#closed = true;
  }
}
