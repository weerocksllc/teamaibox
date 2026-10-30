#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid_arguments");
    values[name.slice(2)] = value;
  }
  if (!new Set(["setup", "restart"]).has(values.phase) || !values.origin || !values.credentials
    || !values["session-file"]?.startsWith("/")) {
    throw new Error("missing_arguments");
  }
  const origin = new URL(values.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("invalid_origin");
  if (values.phase === "setup" && !values["setup-token"]) throw new Error("missing_setup_token");
  return {
    phase: values.phase, origin, credentials: values.credentials,
    setupToken: values["setup-token"], sessionFile: values["session-file"],
  };
}

function cookies(headers) {
  return (headers.getSetCookie?.() ?? []).map((value) => value.split(";", 1)[0]).join("; ");
}

async function main() {
  const selected = argumentsFrom(process.argv.slice(2));
  const credentials = JSON.parse(await readFile(selected.credentials, "utf8"));
  if (typeof credentials.loginName !== "string" || typeof credentials.displayName !== "string"
    || typeof credentials.password !== "string") throw new Error("invalid_credentials");
  const setupToken = selected.setupToken ? (await readFile(selected.setupToken, "utf8")).trim() : null;
  let cookie = "";

  async function request(path, { method = "GET", body, csrf, origin = false } = {}) {
    const headers = { accept: "application/json", "x-forwarded-proto": "https" };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (csrf) headers["x-csrf-token"] = csrf;
    if (origin) headers.origin = selected.origin.origin;
    const response = await fetch(`http://127.0.0.1:8080${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const next = cookies(response.headers);
    if (next) cookie = next;
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { response, value };
  }

  const status = await request("/api/setup/status");
  assert.equal(status.response.status, 200, "setup_status_failed");
  if (selected.phase === "setup") {
    assert.deepEqual(status.value, { required: true, claimProtected: true }, "initial_setup_state_invalid");
    const created = await request("/api/setup/owner", {
      method: "POST",
      origin: true,
      body: { ...credentials, setupToken },
    });
    assert.equal(created.response.status, 201, "durable_owner_setup_failed");
    assert.equal(created.value.recoveryCodes.length, 8, "durable_recovery_count_invalid");
    assert.equal(new Set(created.value.recoveryCodes).size, 8, "durable_recovery_codes_not_unique");
    const signedIn = await request("/api/auth/sign-in", {
      method: "POST",
      origin: true,
      body: { loginName: credentials.loginName, password: credentials.password },
    });
    assert.equal(signedIn.response.status, 200, "durable_owner_sign_in_failed");
    assert.match(cookie, /(?:^|; )__Host-teamaibox-session=[A-Za-z0-9_-]+(?:;|$)/, "durable_session_cookie_missing");
    if (cookie.length > 4096) throw new Error("durable_session_cookie_oversized");
    await writeFile(selected.sessionFile, cookie, { encoding: "utf8", mode: 0o600 });
    const csrf = signedIn.value.csrfToken;
    const locale = await request("/api/preferences/locale", {
      method: "PATCH", origin: true, csrf, body: { locale: "en" },
    });
    const theme = await request("/api/preferences/theme", {
      method: "PATCH", origin: true, csrf, body: { theme: "dark" },
    });
    assert.equal(locale.value.preferredLocale, "en", "durable_locale_write_failed");
    assert.equal(theme.value.preferredTheme, "dark", "durable_theme_write_failed");
    created.value.recoveryCodes.fill("[REDACTED]");
    process.stdout.write(JSON.stringify({
      ownerCreated: true,
      preferencesWritten: true,
      recoveryCodeCount: 8,
      signedIn: true,
    }) + "\n");
    return;
  }

  assert.deepEqual(status.value, { required: false, claimProtected: false }, "durable_bootstrap_not_retained");
  const anonymous = await request("/api/auth/session");
  assert.equal(anonymous.response.status, 401, "restart_created_anonymous_session");
  cookie = (await readFile(selected.sessionFile, "utf8")).trim();
  assert.match(cookie, /(?:^|; )__Host-teamaibox-session=[A-Za-z0-9_-]+(?:;|$)/, "retained_session_cookie_invalid");
  const retainedSession = await request("/api/auth/session");
  assert.equal(retainedSession.response.status, 200, "durable_session_missing_after_restart");
  assert.equal(retainedSession.value.preferences.preferredLocale, "en", "retained_session_locale_missing");
  assert.equal(retainedSession.value.preferences.preferredTheme, "dark", "retained_session_theme_missing");
  const signedIn = await request("/api/auth/sign-in", {
    method: "POST",
    origin: true,
    body: { loginName: credentials.loginName, password: credentials.password },
  });
  assert.equal(signedIn.response.status, 200, "restart_sign_in_failed");
  const session = await request("/api/auth/session");
  assert.equal(session.value.preferences.preferredLocale, "en", "durable_locale_missing_after_restart");
  assert.equal(session.value.preferences.preferredTheme, "dark", "durable_theme_missing_after_restart");
  const repeated = await request("/api/setup/owner", {
    method: "POST",
    origin: true,
    body: { ...credentials, setupToken: "A".repeat(48) },
  });
  assert.equal(repeated.response.status, 409, "restart_reopened_owner_setup");
  process.stdout.write(JSON.stringify({
    bootstrapRetained: true,
    preferencesRetained: true,
    repeatedSetupRejected: true,
    sessionRetainedAfterRestart: true,
    signedInAfterRestart: true,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: String(error?.message || "identity_smoke_failed").slice(0, 160) }) + "\n");
  process.exitCode = 1;
});
