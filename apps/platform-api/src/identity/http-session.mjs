const COOKIE_NAME = "__Host-teamaibox-session";
const CSRF_COOKIE_NAME = "__Host-teamaibox-csrf";

function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function sessionCookie(sessionToken, expiresAt) {
  if (!validToken(sessionToken)) throw new TypeError("session token is invalid");
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime())) throw new TypeError("session expiry is invalid");
  return COOKIE_NAME + "=" + sessionToken
    + "; Path=/; Expires=" + expires.toUTCString()
    + "; HttpOnly; Secure; SameSite=Strict; Priority=High";
}

export function clearSessionCookie() {
  return COOKIE_NAME
    + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0"
    + "; HttpOnly; Secure; SameSite=Strict; Priority=High";
}

export function csrfCookie(csrfToken, expiresAt) {
  if (!validToken(csrfToken)) throw new TypeError("CSRF token is invalid");
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime())) throw new TypeError("CSRF expiry is invalid");
  return CSRF_COOKIE_NAME + "=" + csrfToken
    + "; Path=/; Expires=" + expires.toUTCString()
    + "; Secure; SameSite=Strict; Priority=High";
}

export function clearCsrfCookie() {
  return CSRF_COOKIE_NAME
    + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0"
    + "; Secure; SameSite=Strict; Priority=High";
}

export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;
  const values = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (validToken(value)) values.push(value);
  }
  return values.length === 1 ? values[0] : null;
}

export function readCsrfCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;
  const values = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CSRF_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (validToken(value)) values.push(value);
  }
  return values.length === 1 ? values[0] : null;
}

export const sessionCookieName = COOKIE_NAME;
export const csrfCookieName = CSRF_COOKIE_NAME;
