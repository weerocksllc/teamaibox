import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";
import { MemoryModelLifecycleRepository } from "../src/models/memory-model-lifecycle-repository.mjs";
import { ModelLifecycleHttpApi } from "../src/models/model-lifecycle-http-api.mjs";
import { ModelLifecycleService } from "../src/models/model-lifecycle-service.mjs";

const publicOrigin = "https://spark.test";
const password = "correct horse battery staple";
const profileId = "00000000-0000-4000-8000-000000007811";
const runId = "00000000-0000-4000-8000-000000007812";
const fingerprint = `sha256:${"a".repeat(64)}`;

function request(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: address.port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

async function fixture() {
  const identities = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({
    repository: identities,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }),
  });
  await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password });
  const preferences = new IdentityPreferencesService({ repository: identities });
  const repository = new MemoryModelLifecycleRepository({ profiles: [{
    profileId, profileKey: "llm.spark.nvfp4.v1", fingerprint,
    state: "experimental", updatedAt: new Date("2026-08-11T04:00:00.000Z"),
  }] });
  const validationRuns = new Map([[runId, {
    runId, state: "validating", plan: { profile: { profileKey: "llm.spark.nvfp4.v1", fingerprint } },
  }]]);
  const service = new ModelLifecycleService({
    repository, validationRuns: { async getRun(id) { return validationRuns.get(id) ?? null; } },
    clock: () => new Date("2026-08-11T04:00:00.000Z"),
  });
  const server = createPlatformApiServer({
    authentication, preferences, publicOrigin,
    logger: { warn() {}, info() {}, error() {} },
    modelLifecycleApi: new ModelLifecycleHttpApi({
      service,
      reportService: {
        async generateCard({ context, profileKey: requestedKey }) {
          assert.ok(context.permissions.includes("model:view"));
          return { schemaVersion: 1, profile: { profileKey: requestedKey }, lifecycle: { state: "experimental" } };
        },
      },
    }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function signIn(server) {
  const response = await request(server, {
    method: "POST", path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({ loginName: "owner", password }),
  });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  return {
    csrf: body.csrfToken,
    cookie: response.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; "),
  };
}

function headers(session, extras = {}) {
  return {
    cookie: session.cookie, origin: publicOrigin, "x-csrf-token": session.csrf,
    "x-forwarded-proto": "https", ...extras,
  };
}

test("administrator lifecycle endpoints enforce CSRF, revisions, and explicit non-production opt-in", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const session = await signIn(server);
  const initial = await request(server, {
    path: `/api/v1/admin/model-profiles/${profileId}/lifecycle`, headers: headers(session),
  });
  assert.equal(initial.status, 200, initial.text);
  assert.equal(JSON.parse(initial.text).state, "experimental");

  const profiles = await request(server, {
    path: "/api/v1/admin/model-profiles?limit=50", headers: headers(session),
  });
  assert.equal(profiles.status, 200, profiles.text);
  assert.equal(JSON.parse(profiles.text).data[0].profileKey, "llm.spark.nvfp4.v1");

  const card = await request(server, {
    path: "/api/v1/admin/model-profiles/by-key/llm.spark.nvfp4.v1/card", headers: headers(session),
  });
  assert.equal(card.status, 200, card.text);
  assert.equal(JSON.parse(card.text).profile.profileKey, "llm.spark.nvfp4.v1");

  const noCsrf = await request(server, {
    method: "POST", path: `/api/v1/admin/model-profiles/${profileId}/lifecycle`,
    headers: { cookie: session.cookie, origin: publicOrigin, "x-forwarded-proto": "https", "x-csrf-token": "A".repeat(43), "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, nextState: "validating", reasonKey: "model.lifecycle.validation_started", validationRunId: runId }),
  });
  assert.equal(noCsrf.status, 403);

  const transition = await request(server, {
    method: "POST", path: `/api/v1/admin/model-profiles/${profileId}/lifecycle`,
    headers: headers(session, { "content-type": "application/json" }),
    body: JSON.stringify({ expectedRevision: 1, nextState: "validating", reasonKey: "model.lifecycle.validation_started", validationRunId: runId }),
  });
  assert.equal(transition.status, 200, transition.text);
  assert.equal(JSON.parse(transition.text).revision, 2);

  const invalidOptIn = await request(server, {
    method: "PUT", path: `/api/v1/admin/model-routing-policies/lab.spark/experimental-profiles/${profileId}`,
    headers: headers(session, { "content-type": "application/json" }),
    body: JSON.stringify({ environment: "production", enabled: true, reasonKey: "model.routing.experimental_validation", expiresAt: "2026-08-12T04:00:00.000Z" }),
  });
  assert.equal(invalidOptIn.status, 400, invalidOptIn.text);
  assert.equal(JSON.parse(invalidOptIn.text).error.code, "model_experimental_policy_invalid");
});
