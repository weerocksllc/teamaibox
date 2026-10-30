#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import tls from "node:tls";

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid_arguments");
    values[name.slice(2)] = value;
  }
  if (!values.origin || !values.ca || !values.credentials) throw new Error("missing_arguments");
  const origin = new URL(values.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("invalid_origin");
  return { origin, caPath: values.ca, credentialPath: values.credentials };
}

function cookieValues(headers) {
  const setCookies = headers.getSetCookie?.() ?? [];
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

async function main() {
  const selected = argumentsFrom(process.argv.slice(2));
  const [ca, credentialText] = await Promise.all([
    readFile(selected.caPath),
    readFile(selected.credentialPath, "utf8"),
  ]);
  const credentials = JSON.parse(credentialText);
  if (typeof credentials.loginName !== "string" || typeof credentials.password !== "string") {
    throw new Error("invalid_credentials_file");
  }

  let cookie = "";
  async function request(path, { method = "GET", body, csrf, origin = false } = {}) {
    const headers = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (csrf) headers["x-csrf-token"] = csrf;
    if (origin) headers.origin = selected.origin.origin;
    const response = await fetch(new URL(path, selected.origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher: undefined,
    });
    const setCookie = cookieValues(response.headers);
    if (setCookie) cookie = setCookie;
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { response, value };
  }

  // NODE_EXTRA_CA_CERTS supplies trust for fetch; this explicit TLS connection
  // checks the same CA again for the WebSocket upgrade path.
  const health = await request("/health/ready");
  assert.equal(health.response.status, 200, "https_health_failed");
  assert.equal(health.value.transport, "https", "https_transport_missing");

  const anonymous = await request("/api/auth/session");
  assert.equal(anonymous.response.status, 401, "anonymous_session_not_rejected");

  const signIn = await request("/api/auth/sign-in", {
    method: "POST",
    body: credentials,
    origin: true,
  });
  assert.equal(signIn.response.status, 200, "sign_in_failed");
  assert.equal(signIn.value.authenticated, true, "session_not_authenticated");
  assert.ok(signIn.value.permissions.includes("identity:manage"), "owner_permission_missing");
  assert.match(signIn.value.csrfToken, /^[A-Za-z0-9_-]{32,256}$/, "csrf_token_missing");
  const csrf = signIn.value.csrfToken;

  const session = await request("/api/auth/session");
  assert.equal(session.response.status, 200, "session_read_failed");
  assert.equal(session.value.identity.loginName, credentials.loginName, "identity_mismatch");

  const rejectedCsrf = await request("/api/preferences/theme", {
    method: "PATCH",
    body: { theme: "dark" },
    csrf: "A".repeat(43),
    origin: true,
  });
  assert.equal(rejectedCsrf.response.status, 403, "invalid_csrf_not_rejected");

  const preference = await request("/api/preferences/theme", {
    method: "PATCH",
    body: { theme: "dark" },
    csrf,
    origin: true,
  });
  assert.equal(preference.response.status, 200, "preference_write_failed");
  assert.equal(preference.value.preferredTheme, "dark", "preference_not_applied");

  const events = await request("/events/session?once=1");
  assert.equal(events.response.status, 200, "sse_failed");
  assert.match(String(events.value), /event: session\.ready/, "sse_event_missing");

  await new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const options = {
      host: selected.origin.hostname,
      port: Number(selected.origin.port || 443),
      ca,
      rejectUnauthorized: true,
    };
    if (!isIP(selected.origin.hostname)) options.servername = selected.origin.hostname;
    const socket = tls.connect(options);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("websocket_timeout"));
    }, 5000);
    socket.once("secureConnect", () => {
      socket.write([
        "GET /ws/session HTTP/1.1",
        `Host: ${selected.origin.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${selected.origin.origin}`,
        `Cookie: ${cookie}`,
        "",
        "",
      ].join("\r\n"));
    });
    const chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const marker = payload.indexOf("\r\n\r\n");
      if (marker < 0 || payload.length <= marker + 4) return;
      try {
        assert.match(payload.subarray(0, marker).toString("utf8"), /^HTTP\/1\.1 101 /, "websocket_upgrade_failed");
        assert.equal(payload[marker + 4], 0x81, "websocket_session_frame_missing");
        assert.match(payload.subarray(marker + 6).toString("utf8"), /session\.ready/, "websocket_payload_missing");
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const signOut = await request("/api/auth/sign-out", { method: "POST", csrf, origin: true });
  assert.equal(signOut.response.status, 200, "sign_out_failed");
  const expired = await request("/api/auth/session");
  assert.equal(expired.response.status, 401, "signed_out_session_remains_valid");

  process.stdout.write(JSON.stringify({
    authenticatedSession: true,
    csrf: true,
    health: true,
    permissions: true,
    preferences: true,
    signOut: true,
    sse: true,
    tlsVerified: true,
    websocket: true,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: String(error?.message || "smoke_failed").slice(0, 160) }) + "\n");
  process.exitCode = 1;
});
