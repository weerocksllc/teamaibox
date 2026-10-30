import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(argon2);
const PHC = /^\$argon2id\$v=19\$m=([0-9]+),t=([0-9]+),p=([0-9]+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;
const DEFAULT_PARAMETERS = Object.freeze({
  memory: 65_536,
  passes: 3,
  parallelism: 4,
  tagLength: 32,
});
const COMMON = new Set([
  "123456789012345",
  "passwordpassword",
  "qwertyuiopasdfg",
  "letmeinletmeinletmein",
  "adminadminadmin",
  "teamaiboxteamaibox",
  "dgxsparkdgxspark",
]);

export class PasswordPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

function normalizedPassword(password) {
  if (typeof password !== "string") throw new PasswordPolicyError("password_invalid", "Password must be text");
  const value = password.normalize("NFC");
  const length = [...value].length;
  if (length < 15) throw new PasswordPolicyError("password_too_short", "Password must contain at least 15 characters");
  if (length > 256) throw new PasswordPolicyError("password_too_long", "Password must contain at most 256 characters");
  if (/\p{Cc}/u.test(value)) throw new PasswordPolicyError("password_control_character", "Password must not contain control characters");
  return value;
}

export function validatePasswordPolicy(password, {
  loginName = "",
  displayName = "",
  blocklist = COMMON,
} = {}) {
  const value = normalizedPassword(password);
  const candidate = value.toLocaleLowerCase("en-US");
  const contextual = ["teamaibox", "dgx spark", loginName, displayName]
    .map((item) => String(item).normalize("NFC").trim().toLocaleLowerCase("en-US"))
    .filter((item) => item.length >= 3);
  if (blocklist.has(candidate) || contextual.includes(candidate)) {
    throw new PasswordPolicyError("password_blocklisted", "Password is too common or context-specific");
  }
  return value;
}

function safeParameters(parameters) {
  const value = { ...DEFAULT_PARAMETERS, ...parameters };
  if (!Number.isInteger(value.memory) || value.memory < 8192 || value.memory > 262_144) throw new TypeError("Argon2 memory is outside the safe range");
  if (!Number.isInteger(value.passes) || value.passes < 2 || value.passes > 10) throw new TypeError("Argon2 passes are outside the safe range");
  if (!Number.isInteger(value.parallelism) || value.parallelism < 2 || value.parallelism > 16) throw new TypeError("Argon2 parallelism is outside the safe range");
  if (value.tagLength !== 32) throw new TypeError("Argon2 tag length must be 32 bytes");
  return Object.freeze(value);
}

function encoded(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function decoded(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("invalid encoded password component");
  return Buffer.from(value, "base64url");
}

export class PasswordHasher {
  constructor(parameters = DEFAULT_PARAMETERS) {
    this.parameters = safeParameters(parameters);
  }

  async hash(password, context = {}) {
    const normalized = validatePasswordPolicy(password, context);
    const nonce = randomBytes(16);
    const message = Buffer.from(normalized, "utf8");
    try {
      const result = await derive("argon2id", {
        message,
        nonce,
        ...this.parameters,
      });
      return "$argon2id$v=19$m=" + this.parameters.memory
        + ",t=" + this.parameters.passes
        + ",p=" + this.parameters.parallelism
        + "$" + encoded(nonce)
        + "$" + encoded(result);
    } finally {
      message.fill(0);
      nonce.fill(0);
    }
  }

  async verify(password, encodedHash) {
    if (typeof password !== "string" || [...password].length > 256 || typeof encodedHash !== "string") return false;
    const match = PHC.exec(encodedHash);
    if (!match) return false;
    let parameters;
    try {
      parameters = safeParameters({
        memory: Number(match[1]),
        passes: Number(match[2]),
        parallelism: Number(match[3]),
        tagLength: 32,
      });
    } catch {
      return false;
    }
    const nonce = decoded(match[4]);
    const expected = decoded(match[5]);
    if (nonce.length !== 16 || expected.length !== 32) return false;
    const message = Buffer.from(password.normalize("NFC"), "utf8");
    let actual;
    try {
      actual = await derive("argon2id", { message, nonce, ...parameters });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    } finally {
      message.fill(0);
      nonce.fill(0);
      expected.fill(0);
      actual?.fill(0);
    }
  }
}

export const passwordHashParameters = DEFAULT_PARAMETERS;
