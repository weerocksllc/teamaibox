import { randomUUID } from "node:crypto";
import { UnlockChallengeStore, UnlockError } from "./index.mjs";

const COOKIE = "taib_unlock_challenge";
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function json(status, body, headers = {}) { return { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) }; }
function parseCookie(header) {
  if (typeof header !== "string" || header.length > 4096) return null;
  const values = header.split(";").map((item) => item.trim()).filter((item) => item.startsWith(COOKIE + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32}$/.test(value) ? value : null;
}
function error(error, requestId) {
  const known = error instanceof UnlockError;
  const status = known ? error.status : 500;
  const headers = error?.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {};
  return json(status, { error: { code: known ? error.code : "unlock_internal_error", message: known ? error.message : "Unlock service could not complete the request", requestId } }, headers);
}

export class UnlockHttpApi {
  #service; #challenges; #origin; #networkStatus;
  constructor({ service, expectedOrigin, networkStatusProvider, challengeStore = new UnlockChallengeStore() }) {
    let origin;
    try { origin = new URL(expectedOrigin); } catch { throw new TypeError("unlock HTTPS origin is invalid"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !service?.status || !service?.unlock || !networkStatusProvider?.status) throw new TypeError("unlock HTTP API dependencies are invalid");
    this.#service = service; this.#origin = origin.origin; this.#networkStatus = networkStatusProvider; this.#challenges = challengeStore;
  }
  async handle({ method, pathname, headers = {}, body = null, networkIdentifier, secure = true }) {
    const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(headers["x-request-id"] ?? "") ? headers["x-request-id"] : randomUUID();
    try {
      if (!secure) throw new UnlockError("unlock_https_required", "HTTPS is required", { status: 426 });
      if (method === "GET" && pathname === "/v1/status") {
        return json(200, await this.#service.status({ networkIdentifier, networkStatus: await this.#networkStatus.status() }));
      }
      if (method === "POST" && pathname === "/v1/challenge") {
        if (headers.origin !== this.#origin) throw new UnlockError("unlock_origin_denied", "Unlock origin is invalid", { status: 403 });
        const networkDigest = this.#service.networkDigest(networkIdentifier);
        const challenge = this.#challenges.issue({ networkDigest, origin: this.#origin });
        return json(201, { csrfToken: challenge.token, expiresAt: challenge.expiresAt.toISOString() }, {
          "set-cookie": `${COOKIE}=${challenge.id}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict`,
        });
      }
      if (method === "POST" && pathname === "/v1/unlock") {
        if (headers.origin !== this.#origin) throw new UnlockError("unlock_origin_denied", "Unlock origin is invalid", { status: 403 });
        const networkDigest = this.#service.networkDigest(networkIdentifier);
        this.#challenges.consume({ id: parseCookie(headers.cookie), token: headers["x-unlock-csrf"], networkDigest, origin: this.#origin });
        const result = await this.#service.unlock({ request: body, networkIdentifier, requestId });
        return json(202, result, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict` });
      }
      throw new UnlockError("unlock_not_found", "Unlock route was not found", { status: 404 });
    } catch (cause) {
      return error(cause, requestId);
    }
  }
}

export { SECURITY_HEADERS };
