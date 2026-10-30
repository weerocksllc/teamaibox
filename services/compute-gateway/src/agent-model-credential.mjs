import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z][a-z0-9_.\/-]{2,511}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const PREFIX = "taib_agent_v1";
const AUDIENCE = "compute.openai";
const MAXIMUM_TTL_SECONDS = 300;
const SUPPORTED_SCOPES = new Set(["openai:chat.completions", "openai:responses"]);
const CLAIM_KEYS = Object.freeze([
  "aud", "exp", "iat", "model_aliases", "nonce", "sandbox_id", "scopes",
  "single_sandbox", "sub", "token_id", "v",
].sort());

function invalidCredential() {
  return new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
}

function keyBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 128) {
    throw new TypeError("Agent model signing key must contain 32 through 128 bytes");
  }
  return Buffer.from(value);
}

function safeDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${label} is invalid`);
  return new Date(value);
}

function safeUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} is invalid`);
  return value.toLowerCase();
}

function safeScopes(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > SUPPORTED_SCOPES.size) {
    throw new TypeError("Agent model scopes are invalid");
  }
  const normalized = [...new Set(values)].sort();
  if (normalized.length !== values.length || normalized.some((value) => !SUPPORTED_SCOPES.has(value))) {
    throw new TypeError("Agent model scopes are invalid");
  }
  return normalized;
}

function safeAliases(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    throw new TypeError("Agent model aliases are invalid");
  }
  const normalized = [...new Set(values)].sort();
  if (normalized.length !== values.length
      || normalized.some((value) => typeof value !== "string" || !ALIAS.test(value))) {
    throw new TypeError("Agent model aliases are invalid");
  }
  return normalized;
}

function signature(key, payload) {
  return createHmac("sha256", key).update(`${PREFIX}.${payload}`).digest();
}

function exactClaims(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(CLAIM_KEYS);
}

function routeScope(method, pathname) {
  if (method === "POST" && pathname === "/v1/chat/completions") return "openai:chat.completions";
  if (method === "POST" && pathname === "/v1/responses") return "openai:responses";
  return null;
}

export class AgentModelCredentialAuthority {
  #key;
  #clock;

  constructor({ signingKey, clock = () => new Date() }) {
    if (typeof clock !== "function") throw new TypeError("Agent model credential clock is invalid");
    this.#key = keyBytes(signingKey);
    this.#clock = clock;
  }

  async issue({ subject, sandboxId, audience, scopes, modelAliases, expiresAt, singleSandbox }) {
    const now = safeDate(this.#clock(), "Agent model credential clock");
    const expiry = safeDate(expiresAt, "Agent model credential expiry");
    const issuedSeconds = Math.floor(now.getTime() / 1000);
    const expirySeconds = Math.floor(expiry.getTime() / 1000);
    if (audience !== AUDIENCE || singleSandbox !== true || expirySeconds <= issuedSeconds
        || expirySeconds - issuedSeconds > MAXIMUM_TTL_SECONDS) {
      throw new TypeError("Agent model credential scope is invalid");
    }
    const tokenId = randomUUID();
    const normalizedScopes = safeScopes(scopes);
    const aliases = safeAliases(modelAliases);
    const claims = {
      aud: AUDIENCE,
      exp: expirySeconds,
      iat: issuedSeconds,
      model_aliases: aliases,
      nonce: randomBytes(16).toString("base64url"),
      sandbox_id: safeUuid(sandboxId, "Agent sandbox identifier"),
      scopes: normalizedScopes,
      single_sandbox: true,
      sub: safeUuid(subject, "Agent credential subject"),
      token_id: tokenId,
      v: 1,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const token = `${PREFIX}.${payload}.${signature(this.#key, payload).toString("base64url")}`;
    return Object.freeze({
      token,
      tokenId,
      subject: claims.sub,
      sandboxId: claims.sandbox_id,
      audience: AUDIENCE,
      scopes: Object.freeze(normalizedScopes),
      modelAliases: Object.freeze(aliases),
      expiresAt: new Date(expirySeconds * 1000),
    });
  }

  verify({ token, method, pathname }) {
    try {
      if (typeof token !== "string" || token.length < 64 || token.length > 8192 || /[\s\0]/.test(token)) {
        throw invalidCredential();
      }
      const [prefix, payload, encodedSignature, ...extra] = token.split(".");
      if (prefix !== PREFIX || extra.length || !SEGMENT.test(payload ?? "") || !SEGMENT.test(encodedSignature ?? "")) {
        throw invalidCredential();
      }
      const observed = Buffer.from(encodedSignature, "base64url");
      const expected = signature(this.#key, payload);
      const signatureValid = observed.toString("base64url") === encodedSignature
        && observed.byteLength === expected.byteLength && timingSafeEqual(observed, expected);
      observed.fill(0);
      expected.fill(0);
      if (!signatureValid) throw invalidCredential();
      const raw = Buffer.from(payload, "base64url");
      let claims;
      try {
        if (raw.byteLength > 16_384 || raw.toString("base64url") !== payload) throw invalidCredential();
        claims = JSON.parse(raw.toString("utf8"));
      } finally {
        raw.fill(0);
      }
      const now = safeDate(this.#clock(), "Agent model credential clock");
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const scope = routeScope(method, pathname);
      if (!exactClaims(claims) || claims.v !== 1 || claims.aud !== AUDIENCE
          || claims.single_sandbox !== true || !UUID.test(claims.token_id)
          || !UUID.test(claims.sub) || !UUID.test(claims.sandbox_id)
          || typeof claims.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(claims.nonce)
          || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
          || claims.iat > nowSeconds + 5 || claims.exp <= nowSeconds
          || claims.exp <= claims.iat || claims.exp - claims.iat > MAXIMUM_TTL_SECONDS
          || JSON.stringify(safeScopes(claims.scopes)) !== JSON.stringify(claims.scopes)
          || JSON.stringify(safeAliases(claims.model_aliases)) !== JSON.stringify(claims.model_aliases)
          || !scope || !claims.scopes.includes(scope)) {
        throw invalidCredential();
      }
      return Object.freeze({
        tokenId: claims.token_id.toLowerCase(),
        subject: claims.sub.toLowerCase(),
        sandboxId: claims.sandbox_id.toLowerCase(),
        audience: AUDIENCE,
        scopes: Object.freeze([...claims.scopes]),
        modelAliases: Object.freeze([...claims.model_aliases]),
        issuedAt: new Date(claims.iat * 1000),
        expiresAt: new Date(claims.exp * 1000),
      });
    } catch (error) {
      if (error instanceof PlatformError && error.code === "invalid_credential") throw error;
      throw invalidCredential();
    }
  }

  close() {
    this.#key.fill(0);
  }
}

export class AgentComputeCredentialAuthentication {
  #authority;
  #aliases;

  constructor({ authority, modelAliasMap }) {
    if (!authority?.verify || !(modelAliasMap instanceof Map) || modelAliasMap.size < 1) {
      throw new TypeError("Agent compute credential authentication is incomplete");
    }
    this.#authority = authority;
    this.#aliases = new Map(modelAliasMap);
  }

  async authenticate({ secret, permission, resource, operation }) {
    if (permission !== "ai:invoke" || resource?.kind !== "appliance" || resource?.key !== "*"
        || typeof operation?.method !== "string" || typeof operation?.pathname !== "string") {
      throw invalidCredential();
    }
    const credential = this.#authority.verify({
      token: secret,
      method: operation.method,
      pathname: operation.pathname,
    });
    const modelAliases = credential.modelAliases.map((alias) => this.#aliases.get(alias));
    if (modelAliases.some((alias) => typeof alias !== "string")) throw invalidCredential();
    return Object.freeze({
      identityId: credential.subject,
      identityKind: "agent_sandbox",
      credentialId: credential.tokenId,
      sandboxId: credential.sandboxId,
      permissions: Object.freeze(["ai:invoke"]),
      modelAliases: Object.freeze([...new Set(modelAliases)].sort()),
    });
  }
}

export const agentModelCredentialRouteScope = routeScope;

export async function loadAgentModelSigningKey(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TypeError("Agent model signing key file must be an absolute path");
  }
  const raw = await readFile(path);
  try {
    const encoded = raw.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,171}$/.test(encoded)) throw new TypeError("Agent model signing key file is invalid");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength < 32 || key.byteLength > 128 || key.toString("base64url") !== encoded) {
      key.fill(0);
      throw new TypeError("Agent model signing key file is invalid");
    }
    return key;
  } finally {
    raw.fill(0);
  }
}

export async function loadAgentModelAliasMap(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TypeError("Agent model alias map file must be an absolute path");
  }
  const raw = await readFile(path);
  try {
    let value;
    try { value = JSON.parse(raw.toString("utf8")); }
    catch { throw new TypeError("Agent model alias map file is invalid"); }
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["aliases", "schemaVersion"])
        || value.schemaVersion !== 1 || !value.aliases || typeof value.aliases !== "object" || Array.isArray(value.aliases)) {
      throw new TypeError("Agent model alias map file is invalid");
    }
    const entries = Object.entries(value.aliases);
    const sources = safeAliases(entries.map(([source]) => source));
    if (JSON.stringify(sources) !== JSON.stringify(entries.map(([source]) => source).sort())
        || entries.some(([, target]) => typeof target !== "string" || !ALIAS.test(target))) {
      throw new TypeError("Agent model alias map file is invalid");
    }
    return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
  } finally {
    raw.fill(0);
  }
}
