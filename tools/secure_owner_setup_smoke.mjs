#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid_arguments");
    values[name.slice(2)] = value;
  }
  if (!values.origin || !values.credentials || !values["setup-token"]) throw new Error("missing_arguments");
  const origin = new URL(values.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("invalid_origin");
  return {
    origin,
    credentialPath: values.credentials,
    setupTokenPath: values["setup-token"],
  };
}

function cookieValues(headers) {
  return (headers.getSetCookie?.() ?? []).map((value) => value.split(";", 1)[0]).join("; ");
}

async function main() {
  const selected = argumentsFrom(process.argv.slice(2));
  const [credentialText, setupTokenText] = await Promise.all([
    readFile(selected.credentialPath, "utf8"),
    readFile(selected.setupTokenPath, "utf8"),
  ]);
  const credentials = JSON.parse(credentialText);
  const setupToken = setupTokenText.trim();
  if (typeof credentials.loginName !== "string" || typeof credentials.displayName !== "string"
    || typeof credentials.password !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(setupToken)) {
    throw new Error("invalid_secret_inputs");
  }

  let cookie = "";
  async function request(path, { method = "GET", body, includeOrigin = false } = {}) {
    const headers = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (includeOrigin) headers.origin = selected.origin.origin;
    const response = await fetch(new URL(path, selected.origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const nextCookie = cookieValues(response.headers);
    if (nextCookie) cookie = nextCookie;
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { response, value };
  }

  const health = await request("/health/ready");
  assert.equal(health.response.status, 200, "https_health_failed");
  assert.equal(health.value.transport, "https", "https_transport_missing");

  const before = await request("/api/setup/status");
  assert.equal(before.response.status, 200, "setup_status_failed");
  assert.deepEqual(before.value, { required: true, claimProtected: true }, "setup_not_protected");

  const missingOrigin = await request("/api/setup/owner", {
    method: "POST",
    body: { ...credentials, setupToken },
  });
  assert.equal(missingOrigin.response.status, 403, "missing_origin_not_rejected");

  const wrongProof = await request("/api/setup/owner", {
    method: "POST",
    includeOrigin: true,
    body: { ...credentials, setupToken: "A".repeat(48) },
  });
  assert.equal(wrongProof.response.status, 401, "wrong_setup_proof_not_rejected");

  const created = await request("/api/setup/owner", {
    method: "POST",
    includeOrigin: true,
    body: { ...credentials, setupToken },
  });
  assert.equal(created.response.status, 201, "owner_setup_failed");
  assert.equal(created.value.identity.loginName, credentials.loginName, "owner_identity_mismatch");
  assert.ok(created.value.identity.roles.includes("owner"), "owner_role_missing");
  assert.equal(created.value.recoveryCodes.length, 8, "recovery_code_count_mismatch");
  assert.equal(new Set(created.value.recoveryCodes).size, 8, "recovery_codes_not_unique");
  assert.ok(created.value.recoveryCodes.every((value) => /^taib-recovery-[A-Za-z0-9_-]{32}$/.test(value)), "recovery_code_shape_invalid");

  const repeated = await request("/api/setup/owner", {
    method: "POST",
    includeOrigin: true,
    body: { ...credentials, setupToken },
  });
  assert.equal(repeated.response.status, 409, "repeated_setup_not_rejected");

  const after = await request("/api/setup/status");
  assert.deepEqual(after.value, { required: false, claimProtected: false }, "setup_state_not_closed");

  const signIn = await request("/api/auth/sign-in", {
    method: "POST",
    includeOrigin: true,
    body: { loginName: credentials.loginName, password: credentials.password },
  });
  assert.equal(signIn.response.status, 200, "new_owner_sign_in_failed");
  assert.equal(signIn.value.authenticated, true, "new_owner_session_missing");
  assert.ok(signIn.value.permissions.includes("identity:manage"), "new_owner_permission_missing");

  created.value.recoveryCodes.fill("[REDACTED]");
  process.stdout.write(JSON.stringify({
    deviceProof: true,
    https: true,
    ownerCreated: true,
    recoveryCodesReturnedOnce: true,
    repeatedSetupRejected: true,
    sameOrigin: true,
    signedIn: true,
    statusClosed: true,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: String(error?.message || "setup_smoke_failed").slice(0, 160) }) + "\n");
  process.exitCode = 1;
});
