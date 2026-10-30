import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";
import { CastingHttpApi, matchesCastingHttpRoute } from "../src/casting/casting-http-api.mjs";
import {
  FileDisabledCastingAvailability,
  normalizeDisabledCastingAvailabilityConfiguration,
} from "../src/casting/file-disabled-casting-availability.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";

const ORIGIN = "https://casting.test";
const PASSWORD = "correct horse battery staple";
const SESSION = "50000000-0000-4000-8000-000000000001";

function request(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: address.port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

function serviceFixture() {
  const calls = [];
  const value = (name, result) => async (input) => { calls.push({ name, input }); return result; };
  return { calls, service: {
    startSession: value("startSession", { id: SESSION, state: "pairing" }),
    currentSession: value("currentSession", null), getSession: value("getSession", { id: SESSION }),
    updateAudience: value("updateAudience", { id: SESSION }), stopSession: value("stopSession", { state: "stopped" }),
    forceStop: value("forceStop", { state: "stopped" }), health: value("health", { receiverHealthy: true }),
    createInvitation: value("createInvitation", { id: SESSION }), listInvitations: value("listInvitations", []),
    acceptInvitation: value("acceptInvitation", { state: "accepted" }), declineInvitation: value("declineInvitation", { state: "declined" }),
    join: value("join", { mediaCredential: "returned-only" }), leave: value("leave", { left: true }),
    createMediaConnection: value("createMediaConnection", { url: "wss://casting.test/livekit" }),
    listViewers: value("listViewers", []), removeViewer: value("removeViewer", { removed: true }),
    handleInitiatorSignOut: value("handleInitiatorSignOut", null),
  } };
}

function readyAvailability() {
  return {
    status() {
      return {
        schemaVersion: 1,
        object: "cast.availability",
        mode: "runtime",
        state: "ready",
        receiverReady: true,
        sessionStartAllowed: true,
        receiverAdvertisementAllowed: true,
        outputs: {
          hdmi: { state: "available", reasonCode: null },
          browser: { state: "available", reasonCode: null },
        },
        gates: [],
        limitations: { appleCertified: false, fairPlayDrmSupported: false, syntheticAcceptanceAllowed: false },
        successor: { atomicCutoverRequired: true },
      };
    },
    assertSessionStartAllowed() {},
  };
}

async function fixture({ castingApi = null } = {}) {
  const repository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({ repository,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }) });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: PASSWORD });
  const mock = serviceFixture();
  const server = createPlatformApiServer({ authentication,
    preferences: new IdentityPreferencesService({ repository }), publicOrigin: ORIGIN,
    logger: { info() {}, warn() {}, error() {} },
    castingApi: castingApi ?? new CastingHttpApi({ service: mock.service, availability: readyAvailability() }) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, ...mock };
}

async function signIn(server) {
  const response = await request(server, { method: "POST", path: "/api/auth/sign-in",
    headers: { origin: ORIGIN, "x-forwarded-proto": "https", "content-type": "application/json" },
    body: JSON.stringify({ loginName: "owner", password: PASSWORD }) });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  return { csrf: body.csrfToken, cookie: response.headers["set-cookie"].map((item) => item.split(";", 1)[0]).join("; ") };
}

test("casting route matcher covers session, invitation, viewer, health, and stop endpoints", () => {
  assert.equal(matchesCastingHttpRoute("GET", "/api/v1/casting/availability"), true);
  assert.equal(matchesCastingHttpRoute("POST", "/api/v1/casting/availability"), false);
  assert.equal(matchesCastingHttpRoute("POST", "/api/v1/casting/sessions"), true);
  assert.equal(matchesCastingHttpRoute("GET", "/api/v1/casting/sessions/current"), true);
  assert.equal(matchesCastingHttpRoute("PATCH", `/api/v1/casting/sessions/${SESSION}/audience`), true);
  assert.equal(matchesCastingHttpRoute("POST", `/api/v1/casting/sessions/${SESSION}/force-stop`), true);
  assert.equal(matchesCastingHttpRoute("POST", `/api/v1/casting/sessions/${SESSION}/media-connection`), true);
  assert.equal(matchesCastingHttpRoute("GET", `/api/v1/casting/sessions/${SESSION}/health`), true);
  assert.equal(matchesCastingHttpRoute("DELETE", `/api/v1/casting/sessions/${SESSION}`), false);
});

test("disabled availability is public-safe and rejects every session route without touching a runtime", async (t) => {
  const configuration = JSON.parse(await readFile(new URL("../../../deploy/casting/wireless-casting-control-plane.disabled.v1.json", import.meta.url), "utf8"));
  const availability = new FileDisabledCastingAvailability({ configuration });
  const api = new CastingHttpApi({ availability });
  const { server, calls } = await fixture({ castingApi: api });
  t.after(() => server.close());
  const anonymous = await request(server, { path: "/api/v1/casting/availability",
    headers: { "x-forwarded-proto": "https" } });
  assert.equal(anonymous.status, 401, anonymous.text);
  const signed = await signIn(server);

  const status = await request(server, { path: "/api/v1/casting/availability",
    headers: { cookie: signed.cookie, "x-forwarded-proto": "https" } });
  assert.equal(status.status, 200, status.text);
  const body = JSON.parse(status.text);
  assert.equal(body.object, "cast.availability");
  assert.equal(body.state, "unsupported");
  assert.equal(body.receiverReady, false);
  assert.equal(body.sessionStartAllowed, false);
  assert.equal(body.limitations.appleCertified, false);
  assert.equal(body.limitations.fairPlayDrmSupported, false);
  assert.equal(body.gates.length, 7);
  assert.equal(JSON.stringify(body).includes("sourceBindings"), false);
  assert.equal(JSON.stringify(body).includes("/"), false);

  const denied = await request(server, { method: "POST", path: "/api/v1/casting/sessions",
    headers: { cookie: signed.cookie, origin: ORIGIN, "x-forwarded-proto": "https",
      "x-csrf-token": signed.csrf, "idempotency-key": "cast-disabled", "content-type": "application/json" },
    body: JSON.stringify({ output_sinks: ["browser"], ttl_seconds: 900 }) });
  assert.equal(denied.status, 503, denied.text);
  const error = JSON.parse(denied.text).error;
  assert.equal(error.code, "cast_capability_unavailable");
  assert.equal(error.retryable, false);
  assert.equal(error.details.receiverReady, false);
  assert.equal(error.details.startAllowed, false);
  assert.equal(error.details.gateCodes.includes("airplay_supply_chain_human_decisions_pending"), true);

  const current = await request(server, { path: "/api/v1/casting/sessions/current",
    headers: { cookie: signed.cookie, "x-forwarded-proto": "https" } });
  assert.equal(current.status, 503, current.text);
  assert.equal(JSON.parse(current.text).error.code, "cast_capability_unavailable");
  const joined = await request(server, { method: "POST", path: `/api/v1/casting/sessions/${SESSION}/join`,
    headers: { cookie: signed.cookie, origin: ORIGIN, "x-forwarded-proto": "https",
      "x-csrf-token": signed.csrf, "content-type": "application/json" },
    body: JSON.stringify({ browser_instance_id: "cast-browser:test" }) });
  assert.equal(joined.status, 503, joined.text);
  assert.equal(JSON.parse(joined.text).error.code, "cast_capability_unavailable");
  assert.deepEqual(calls, []);
});

test("disabled availability configuration rejects any positive readiness claim", async () => {
  const configuration = JSON.parse(await readFile(new URL("../../../deploy/casting/wireless-casting-control-plane.disabled.v1.json", import.meta.url), "utf8"));
  configuration.claims.receiverReady = true;
  assert.throws(() => normalizeDisabledCastingAvailabilityConfiguration(configuration), /positive claim/);
});

test("Platform casting routes require same-origin CSRF and forward idempotent start input", async (t) => {
  const { server, calls } = await fixture();
  t.after(() => server.close());
  const signed = await signIn(server);
  const denied = await request(server, { method: "POST", path: "/api/v1/casting/sessions",
    headers: { cookie: signed.cookie, origin: "https://wrong.test", "x-forwarded-proto": "https",
      "x-csrf-token": signed.csrf, "idempotency-key": "cast-1", "content-type": "application/json" },
    body: JSON.stringify({ output_sinks: ["browser"] }) });
  assert.equal(denied.status, 403);

  const started = await request(server, { method: "POST", path: "/api/v1/casting/sessions",
    headers: { cookie: signed.cookie, origin: ORIGIN, "x-forwarded-proto": "https",
      "x-csrf-token": signed.csrf, "idempotency-key": "cast-1", "content-type": "application/json" },
    body: JSON.stringify({ output_sinks: ["browser"], browser_audience: "owner_only", ttl_seconds: 600 }) });
  assert.equal(started.status, 201, started.text);
  assert.equal(calls.at(-1).name, "startSession");
  assert.equal(calls.at(-1).input.idempotencyKey, "cast-1");
  assert.deepEqual(calls.at(-1).input.input.outputSinks, ["browser"]);

  const current = await request(server, { path: "/api/v1/casting/sessions/current",
    headers: { cookie: signed.cookie, "x-forwarded-proto": "https" } });
  assert.equal(current.status, 200, current.text);
  assert.equal(calls.at(-1).name, "currentSession");

  const signedOut = await request(server, { method: "POST", path: "/api/auth/sign-out",
    headers: { cookie: signed.cookie, origin: ORIGIN, "x-forwarded-proto": "https",
      "x-csrf-token": signed.csrf, "content-type": "application/json" }, body: "{}" });
  assert.equal(signedOut.status, 200, signedOut.text);
  assert.equal(calls.at(-1).name, "handleInitiatorSignOut");
  assert.match(calls.at(-1).input, /^[0-9a-f-]{36}$/);
});

test("a service without explicit runtime admission remains disabled and never starts a receiver", async () => {
  const { service, calls } = serviceFixture();
  const api = new CastingHttpApi({ service });
  const context = { identityId: "20000000-0000-4000-8000-000000000001" };
  const status = await api.handle({ method: "GET", pathname: "/api/v1/casting/availability", context });
  assert.equal(status.body.mode, "disabled");
  assert.equal(status.body.receiverReady, false);
  assert.equal(status.body.receiverAdvertisementAllowed, false);
  assert.deepEqual(status.body.gates.map((gate) => gate.code), ["casting_runtime_admission_not_configured"]);
  await assert.rejects(api.handle({ method: "POST", pathname: "/api/v1/casting/sessions",
    body: { output_sinks: ["browser"] }, context, headers: { "idempotency-key": "cast-default-deny" } }),
  (error) => error.code === "cast_capability_unavailable"
    && error.details?.gateCodes?.includes("casting_runtime_admission_not_configured"));
  assert.deepEqual(calls, []);
});

test("an asynchronous admission denial completes before a custom service can start", async () => {
  const { service, calls } = serviceFixture();
  const availability = readyAvailability();
  availability.status = async () => readyAvailability().status();
  availability.assertSessionStartAllowed = async () => {
    await Promise.resolve();
    throw new Error("asynchronous admission denied");
  };
  const api = new CastingHttpApi({ service, availability });
  const status = await api.handle({ method: "GET", pathname: "/api/v1/casting/availability",
    context: { identityId: "20000000-0000-4000-8000-000000000001" } });
  assert.equal(status.body.state, "ready");
  await assert.rejects(api.handle({ method: "POST", pathname: "/api/v1/casting/sessions",
    body: { output_sinks: ["browser"] },
    context: { identityId: "20000000-0000-4000-8000-000000000001" },
    headers: { "idempotency-key": "cast-async-deny" } }), /asynchronous admission denied/);
  assert.deepEqual(calls, []);
});

test("CastingHttpApi never accepts a missing start idempotency key", async () => {
  const { service } = serviceFixture();
  const api = new CastingHttpApi({ service, availability: readyAvailability() });
  await assert.rejects(api.handle({ method: "POST", pathname: "/api/v1/casting/sessions", body: { output_sinks: ["browser"] },
    context: { identityId: "20000000-0000-4000-8000-000000000001" }, headers: {} }),
  (error) => error.code === "cast_idempotency_required");
});

test("casting leave forwards the requesting browser without widening legacy scope", async () => {
  const { service, calls } = serviceFixture();
  const api = new CastingHttpApi({ service, availability: readyAvailability() });
  const context = { identityId: "20000000-0000-4000-8000-000000000001" };
  for (const body of [{ browserInstanceId: "browser-instance-one" }, { browser_instance_id: "browser-instance-two" }, {}]) {
    await api.handle({ method: "POST", pathname: `/api/v1/casting/sessions/${SESSION}/leave`, body, context });
    assert.equal(calls.at(-1).name, "leave");
    assert.equal(calls.at(-1).input.browserInstanceId, body.browserInstanceId ?? body.browser_instance_id);
  }
});
