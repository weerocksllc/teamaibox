import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PasswordHasher } from "../src/identity/password.mjs";
import { OwnerRecoveryProofAuthority } from "../src/identity/owner-recovery-authority.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";

const publicOrigin = "https://spark.test";
const ownerPassword = "correct horse battery staple";

test('locale intent survives preference save, session refresh and a new sign-in', async t => {
  const {server}=await fixture();t.after(()=>new Promise(resolve=>server.close(resolve)));
  const login=()=>request(server,{method:'POST',path:'/api/auth/sign-in',
    headers:{origin:publicOrigin,'x-forwarded-proto':'https','content-type':'application/json'},
    body:JSON.stringify({loginName:'owner',password:ownerPassword})});
  const initial=await login();assert.equal(initial.status,200);
  const value=JSON.parse(initial.text);assert.equal(value.preferences.preferredLocaleExplicit,false);
  const cookie=initial.headers['set-cookie'].map(item=>item.split(';',1)[0]).join('; ');
  const saved=await request(server,{method:'PATCH',path:'/api/preferences/locale',
    headers:{cookie,origin:publicOrigin,'x-forwarded-proto':'https','content-type':'application/json','x-csrf-token':value.csrfToken},
    body:JSON.stringify({locale:'ja'})});
  assert.equal(saved.status,200);
  const refreshed=await request(server,{path:'/api/auth/session',headers:{cookie,'x-forwarded-proto':'https'}});
  assert.equal(JSON.parse(refreshed.text).preferences.preferredLocaleExplicit,true);
  const again=JSON.parse((await login()).text);
  assert.equal(again.preferences.preferredLocale,'ja');assert.equal(again.preferences.preferredLocaleExplicit,true);
});

function request(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

function websocket(server, headers) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/ws/session",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    outgoing.once("upgrade", (response, socket, head) => {
      const finish = (payload) => {
        socket.destroy();
        resolve({ status: response.statusCode, payload });
      };
      if (head.length) finish(head);
      else socket.once("data", finish);
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("WebSocket bootstrap timed out"));
      });
    });
    outgoing.once("response", (response) => reject(new Error(`unexpected WebSocket response ${response.statusCode}`)));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function fixture(serverOptions = {}, { bootstrap = true } = {}) {
  const repository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({
    repository,
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }),
    ...(serverOptions.ownerRecoveryAuthority ? { recoveryAuthority: serverOptions.ownerRecoveryAuthority } : {}),
  });
  let bootstrapResult = null;
  if (bootstrap) {
    bootstrapResult = await authentication.bootstrapOwner({ loginName: "owner", displayName: "Owner", password: ownerPassword });
  }
  const preferences = new IdentityPreferencesService({ repository });
  const logger = { warn() {}, info() {}, error() {} };
  const server = createPlatformApiServer({ authentication, preferences, publicOrigin, logger, ...serverOptions });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, bootstrapResult };
}

test("exposes protected office-set control only through its narrow loopback handler", async (t) => {
  const calls = [];
  const protectedOfficeSetControlHandler = {
    matches(method, pathname) {
      return method === "POST" && pathname === "/internal/v1/protected-office-set/action";
    },
    async handle(input) {
      calls.push(input);
      return {
        schemaVersion: 1,
        protocol: "teamaibox.protected-office-set-control.v1",
        kind: "action",
        status: "passed",
        result: { accepted: true },
      };
    },
  };
  const { server } = await fixture({ protectedOfficeSetControlHandler });
  t.after(() => server.close());

  const response = await request(server, {
    method: "POST",
    path: "/internal/v1/protected-office-set/action",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "preflight", input: { runId: "bounded" } }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).result.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].remoteAddress, "127.0.0.1");
  assert.equal(calls[0].path, "/internal/v1/protected-office-set/action");
});

test("rejects an incomplete protected office-set control handler", async () => {
  await assert.rejects(() => fixture({ protectedOfficeSetControlHandler: { async handle() {} } }),
    /protected office-set control handler is invalid/);
});

test("creates the first owner once over same-origin HTTPS and returns recovery codes only in that response", async (t) => {
  const setupToken = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
  const { server } = await fixture({
    ownerSetupAuthority: { verify: async (candidate) => candidate === setupToken },
  }, { bootstrap: false });
  t.after(() => server.close());

  const status = await request(server, {
    path: "/api/setup/status",
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.text), { required: true, claimProtected: true, ownerRecoveryAvailable: false });

  const body = JSON.stringify({
    loginName: "owner",
    displayName: "设备所有者",
    password: ownerPassword,
    setupToken,
  });
  const insecure = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body,
  });
  assert.equal(insecure.status, 426);
  const crossOrigin = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: "https://evil.test", "x-forwarded-proto": "https" },
    body,
  });
  assert.equal(crossOrigin.status, 403);
  const denied = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({
      loginName: "owner",
      displayName: "设备所有者",
      password: ownerPassword,
      setupToken: "Z".repeat(43),
    }),
  });
  assert.equal(denied.status, 401);
  assert.equal(JSON.parse(denied.text).error.code, "setup_denied");

  const created = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body,
  });
  assert.equal(created.status, 201);
  const result = JSON.parse(created.text);
  assert.equal(result.identity.loginName, "owner");
  assert.deepEqual(result.identity.roles, ["owner"]);
  assert.equal(result.recoveryCodes.length, 8);
  assert.equal(new Set(result.recoveryCodes).size, 8);
  assert.equal(created.headers["set-cookie"], undefined);

  const complete = await request(server, {
    path: "/api/setup/status",
    headers: { "x-forwarded-proto": "https" },
  });
  assert.deepEqual(JSON.parse(complete.text), { required: false, claimProtected: false, ownerRecoveryAvailable: false });
  const repeated = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body,
  });
  assert.equal(repeated.status, 409);
  assert.equal(JSON.parse(repeated.text).error.code, "bootstrap_complete");
});

test("fails closed when remote first-owner setup has no protected device proof", async (t) => {
  const { server } = await fixture({}, { bootstrap: false });
  t.after(() => server.close());
  const status = await request(server, {
    path: "/api/setup/status",
    headers: { "x-forwarded-proto": "https" },
  });
  assert.deepEqual(JSON.parse(status.text), { required: true, claimProtected: false, ownerRecoveryAvailable: false });
  const response = await request(server, {
    method: "POST",
    path: "/api/setup/owner",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({
      setupToken: "Z".repeat(43),
      loginName: "owner",
      displayName: "Owner",
      password: ownerPassword,
    }),
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.text).error.code, "setup_unavailable");
});

test("recovers the existing owner through a one-time browser challenge and local container proof", async (t) => {
  const authority = new OwnerRecoveryProofAuthority(randomBytes(48).toString("base64url"));
  const { server, bootstrapResult } = await fixture({ ownerRecoveryAuthority: authority });
  t.after(() => { server.close(); authority.close(); });
  const headers = { origin: publicOrigin, "x-forwarded-proto": "https", "content-type": "application/json" };

  const status = await request(server, { path: "/api/setup/status", headers: { "x-forwarded-proto": "https" } });
  assert.deepEqual(JSON.parse(status.text), { required: false, claimProtected: false, ownerRecoveryAvailable: true });
  const insecure = await request(server, { method: "POST", path: "/api/auth/owner-recovery/challenge", headers: { origin: publicOrigin }, body: "{}" });
  assert.equal(insecure.status, 426);
  const crossOrigin = await request(server, { method: "POST", path: "/api/auth/owner-recovery/challenge",
    headers: { origin: "https://evil.test", "x-forwarded-proto": "https", "content-type": "application/json" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);

  const oldSignIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers,
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  assert.equal(oldSignIn.status, 200);
  const oldCookie = oldSignIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const challengeResponse = await request(server, { method: "POST", path: "/api/auth/owner-recovery/challenge", headers, body: "{}" });
  assert.equal(challengeResponse.status, 201);
  const challenge = JSON.parse(challengeResponse.text);
  const proof = authority.issueProof(challenge.challenge);
  const replacementPassword = "a completely new owner recovery phrase";
  const recovered = await request(server, { method: "POST", path: "/api/auth/owner-recovery", headers,
    body: JSON.stringify({ challenge: challenge.challenge, localRecoveryProof: proof,
      recoveryCode: bootstrapResult.recoveryCodes[0], newPassword: replacementPassword }) });
  assert.equal(recovered.status, 200);
  assert.equal(JSON.parse(recovered.text).recoveryCodes.length, 8);
  assert.equal((await request(server, { path: "/api/auth/session", headers: { cookie: oldCookie, "x-forwarded-proto": "https" } })).status, 401);
  assert.equal((await request(server, { method: "POST", path: "/api/auth/sign-in", headers,
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }) })).status, 401);
  assert.equal((await request(server, { method: "POST", path: "/api/auth/sign-in", headers,
    body: JSON.stringify({ loginName: "owner", password: replacementPassword }) })).status, 200);
  const replay = await request(server, { method: "POST", path: "/api/auth/owner-recovery", headers,
    body: JSON.stringify({ challenge: challenge.challenge, localRecoveryProof: proof,
      recoveryCode: bootstrapResult.recoveryCodes[0], newPassword: "another replacement phrase long enough" }) });
  assert.equal(replay.status, 401);
  assert.equal(JSON.parse(replay.text).error.code, "recovery_failed");
});

test("rotates recovery codes only for the same authenticated owner through CSRF", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text);
  const cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const denied = await request(server, { method: "POST", path: "/api/auth/recovery-codes/rotate",
    headers: { cookie, origin: publicOrigin, "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(denied.status, 401);
  const rotated = await request(server, { method: "POST", path: "/api/auth/recovery-codes/rotate",
    headers: { cookie, origin: publicOrigin, "x-forwarded-proto": "https", "x-csrf-token": session.csrfToken,
      "content-type": "application/json" }, body: "{}" });
  assert.equal(rotated.status, 200);
  assert.equal(JSON.parse(rotated.text).recoveryCodes.length, 8);
});

test("serves user activity through authenticated ownership context and CSRF-protected cancellation", async (t) => {
  const calls = [];
  const userActivityApi = {
    matches(method, pathname) { return (method === "GET" && pathname === "/api/v1/user/activity") || (method === "POST" && pathname.endsWith("/cancel")); },
    async handle(input) { calls.push(input); return { kind: "json", status: input.method === "GET" ? 200 : 202, body: { identityId: input.context.identity.id, permissions: input.context.permissions } }; },
  };
  const { server } = await fixture({ userActivityApi });
  t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text), cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const overview = await request(server, { path: "/api/v1/user/activity", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(overview.status, 200);
  assert.ok(JSON.parse(overview.text).permissions.includes("task:own:view"));
  const denied = await request(server, { method: "POST", path: "/api/v1/user/tasks/018f6f18-24d7-7c21-9b62-8c0174199591/cancel", headers: { cookie, origin: publicOrigin, "x-forwarded-proto": "https" } });
  assert.equal(denied.status, 401);
  const cancelled = await request(server, { method: "POST", path: "/api/v1/user/tasks/018f6f18-24d7-7c21-9b62-8c0174199591/cancel", headers: { cookie, origin: publicOrigin, "x-forwarded-proto": "https", "x-csrf-token": session.csrfToken } });
  assert.equal(cancelled.status, 202);
  assert.equal(calls.length, 2);
});

test("serves credential inventory through a session and CSRF-protects one-time issuance", async (t) => {
  const calls = [];
  const credentialApi = {
    matches(method, pathname) { return pathname === "/api/v1/developer/credentials" && new Set(["GET", "POST"]).has(method); },
    async handle(input) { calls.push(input); return { kind: "json", status: input.method === "GET" ? 200 : 201,
      body: input.method === "GET" ? { object: "list", data: [] } : { credential: { id: "018f6f18-24d7-7c21-9b62-8c0174199701" }, secret: "shown-once" } }; },
  };
  const { server } = await fixture({ credentialApi });
  t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text);
  const cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  assert.equal((await request(server, { path: "/api/v1/developer/credentials", headers: { cookie, "x-forwarded-proto": "https" } })).status, 200);
  const body = JSON.stringify({ display_name: "CLI", scopes: [{ permission_key: "ai:invoke", resource_kind: "appliance", resource_key: "*" }], expires_at: "2026-08-26T00:00:00.000Z" });
  assert.equal((await request(server, { method: "POST", path: "/api/v1/developer/credentials",
    headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body })).status, 401);
  const issued = await request(server, { method: "POST", path: "/api/v1/developer/credentials",
    headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https" }, body });
  assert.equal(issued.status, 201);
  assert.equal(JSON.parse(issued.text).secret, "shown-once");
  assert.equal(calls.length, 2);
});

test("serves application facts only through an authenticated HTTPS session", async (t) => {
  const calls = [];
  const applicationCatalogApi = {
    matches(method, pathname) { return method === "GET" && pathname === "/api/v1/applications"; },
    async handle(input) { calls.push(input); return { kind: "json", status: 200, body: { schemaVersion: 1, applications: [], identityId: input.context.identity.id } }; },
  };
  const { server } = await fixture({ applicationCatalogApi });
  t.after(() => server.close());
  const anonymous = await request(server, { path: "/api/v1/applications", headers: { "x-forwarded-proto": "https" } });
  assert.equal(anonymous.status, 401);
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const catalog = await request(server, { path: "/api/v1/applications", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(catalog.status, 200);
  assert.equal(JSON.parse(catalog.text).schemaVersion, 1);
  assert.equal(calls.length, 1);
});

test("serves operations reads and CSRF-protects diagnostic export mutations", async (t) => {
  const calls = [];
  const operationsApi = {
    matches(method, pathname) { return (method === "GET" && pathname === "/api/v1/admin/operations/health") || (method === "POST" && pathname === "/api/v1/admin/operations/diagnostic-exports"); },
    async handle(input) { calls.push(input); return { kind: "json", status: input.method === "GET" ? 200 : 201, body: { permissions: input.context.permissions, body: input.body } }; },
  };
  const { server } = await fixture({ operationsApi });
  t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text), cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const health = await request(server, { path: "/api/v1/admin/operations/health", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(health.status, 200);
  assert.ok(JSON.parse(health.text).permissions.includes("operations:view"));
  const denied = await request(server, { method: "POST", path: "/api/v1/admin/operations/diagnostic-exports", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(denied.status, 401);
  const exported = await request(server, { method: "POST", path: "/api/v1/admin/operations/diagnostic-exports", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https" }, body: JSON.stringify({ correlationId: "request-diagnostic-12345678" }) });
  assert.equal(exported.status, 201);
  assert.equal(JSON.parse(exported.text).body.correlationId, "request-diagnostic-12345678");
  assert.equal(calls.length, 2);
});

test("serves queue facts and CSRF-protects policy and cancellation mutations", async (t) => {
  const calls = [], jobId = "018f6f18-24d7-7c21-9b62-8c0174199691";
  const queueAdministrationApi = {
    matches(method, pathname) { return (method === "GET" && pathname === "/api/v1/admin/queues")
      || (method === "PUT" && pathname === "/api/v1/admin/queues/policy")
      || (method === "POST" && pathname === `/api/v1/admin/jobs/${jobId}/cancel`); },
    async handle(input) { calls.push(input); return { kind: "json", status: 200, body: { permissions: input.context.permissions, body: input.body } }; },
  };
  const { server } = await fixture({ queueAdministrationApi });
  t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text), cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const overview = await request(server, { path: "/api/v1/admin/queues", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(overview.status, 200);
  assert.ok(JSON.parse(overview.text).permissions.includes("queue:view"));
  const denied = await request(server, { method: "PUT", path: "/api/v1/admin/queues/policy", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(denied.status, 401);
  const updated = await request(server, { method: "PUT", path: "/api/v1/admin/queues/policy", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https" }, body: JSON.stringify({ expectedRevision: 1, policy: { minimumPriority: 0 } }) });
  assert.equal(updated.status, 200);
  const cancelled = await request(server, { method: "POST", path: `/api/v1/admin/jobs/${jobId}/cancel`, headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https" }, body: JSON.stringify({ confirmation: `CANCEL ${jobId}` }) });
  assert.equal(cancelled.status, 200);
  assert.equal(calls.length, 3);
});

test("separates CSRF-protected plugin delegation management from bearer-only plugin invocation", async (t) => {
  const calls = [];
  const issuePath = "/api/v1/plugins/example.team-notes/delegations";
  const invokePath = "/api/plugin/v1/invoke";
  const pluginAccessApi = {
    matches(method, pathname) { return method === "POST" && new Set([issuePath, invokePath]).has(pathname); },
    routeKind(method, pathname) { return pathname === invokePath ? "delegated" : "user"; },
    async handle(input) { calls.push(input); return { kind: "json", status: input.pathname === invokePath ? 200 : 201,
      body: { routeKind: this.routeKind(input.method, input.pathname), identityId: input.context?.identity?.id ?? null } }; },
  };
  const { server } = await fixture({ pluginAccessApi });
  t.after(() => server.close());

  const signedIn = await request(server, { method: "POST", path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signedIn.text);
  const cookie = signedIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const issueBody = JSON.stringify({ grants: [{ scope: "files:read", resource: { kind: "team", key: "team.default" } }] });

  const missingCsrf = await request(server, { method: "POST", path: issuePath,
    headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body: issueBody });
  assert.equal(missingCsrf.status, 401);
  const crossOrigin = await request(server, { method: "POST", path: issuePath,
    headers: { cookie, origin: "https://evil.test", "content-type": "application/json", "x-csrf-token": session.csrfToken,
      "x-forwarded-proto": "https" }, body: issueBody });
  assert.equal(crossOrigin.status, 403);
  const issued = await request(server, { method: "POST", path: issuePath,
    headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken,
      "x-forwarded-proto": "https" }, body: issueBody });
  assert.equal(issued.status, 201);
  assert.equal(JSON.parse(issued.text).routeKind, "user");

  const invokeBody = JSON.stringify({ scope: "files:read", resource: { kind: "team", key: "team.default" },
    operation: "files.list", body: { path: "/notes", pageSize: 10 } });
  const insecure = await request(server, { method: "POST", path: invokePath,
    headers: { authorization: "Bearer delegated-placeholder", "content-type": "application/json" }, body: invokeBody });
  assert.equal(insecure.status, 426);
  const invoked = await request(server, { method: "POST", path: invokePath,
    headers: { authorization: "Bearer delegated-placeholder", "content-type": "application/json", "x-forwarded-proto": "https" },
    body: invokeBody });
  assert.equal(invoked.status, 200);
  assert.equal(JSON.parse(invoked.text).identityId, null);
  assert.equal(calls.length, 2);
});

test("serves the audit chain only through an authenticated administrator context", async (t) => {
  const calls = [];
  const auditApi = {
    matches(method, pathname) { return method === "GET" && pathname === "/api/v1/admin/audit/verify"; },
    async handle(input) { calls.push(input); return { kind: "json", status: 200, body: { valid: true, permissions: input.context.permissions } }; },
  };
  const { server } = await fixture({ auditApi });
  t.after(() => server.close());
  const anonymous = await request(server, { path: "/api/v1/admin/audit/verify", headers: { "x-forwarded-proto": "https" } });
  assert.equal(anonymous.status, 401);
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const verified = await request(server, { path: "/api/v1/admin/audit/verify", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(verified.status, 200);
  assert.ok(JSON.parse(verified.text).permissions.includes("audit:view"));
  assert.equal(calls.length, 1);
});

test("serves plugin inventory and CSRF-protects plugin lifecycle mutations", async (t) => {
  const calls = [];
  const pluginAdministrationApi = {
    matches(method, pathname) { return (method === "GET" && pathname === "/api/v1/admin/plugins")
      || (method === "POST" && pathname === "/api/v1/admin/plugins/example.notes/enable"); },
    async handle(input) { calls.push(input); return { kind: "json", status: 200, body: { permissions: input.context.permissions, body: input.body, requestId: input.requestId } }; },
  };
  const { server } = await fixture({ pluginAdministrationApi });
  t.after(() => server.close());
  const anonymous = await request(server, { path: "/api/v1/admin/plugins", headers: { "x-forwarded-proto": "https" } });
  assert.equal(anonymous.status, 401);
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text), cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const overview = await request(server, { path: "/api/v1/admin/plugins", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(overview.status, 200); assert.ok(JSON.parse(overview.text).permissions.includes("plugin:view"));
  const denied = await request(server, { method: "POST", path: "/api/v1/admin/plugins/example.notes/enable", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(denied.status, 401);
  const enabled = await request(server, { method: "POST", path: "/api/v1/admin/plugins/example.notes/enable", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https", "x-correlation-id": "plugin-enable-request-0001" }, body: JSON.stringify({ operationKey: "plugin-enable-operation-0001" }) });
  assert.equal(enabled.status, 200); assert.equal(JSON.parse(enabled.text).body.operationKey, "plugin-enable-operation-0001"); assert.equal(calls.length, 2);
});

test("retired archive endpoints are absent", async (t) => {
  const { server } = await fixture(); t.after(() => server.close());
  for (const [method, path] of [["GET", "/api/v1/admin/backups"], ["POST", "/api/v1/admin/backups/sets"]]) {
    const result = await request(server, { method, path, headers: { "x-forwarded-proto": "https", origin: publicOrigin } });
    assert.equal(result.status, 404);
  }
});

test("serves maintenance reads and CSRF-protects update execution through the administrator boundary", async (t) => {
  const calls = [], planId = "018f6f18-24d7-7c21-9b62-8c0174199601";
  const maintenanceApi = {
    matches(method, pathname) { return (method === "GET" && pathname === "/api/v1/admin/updates") || (method === "POST" && pathname === `/api/v1/admin/updates/plans/${planId}/execute`); },
    async handle(input) { calls.push(input); return { kind: "json", status: 200, body: { permissions: input.context.permissions, body: input.body } }; },
  };
  const { server } = await fixture({ maintenanceApi }); t.after(() => server.close());
  const signIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signIn.text), cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const overview = await request(server, { path: "/api/v1/admin/updates", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(overview.status, 200); assert.ok(JSON.parse(overview.text).permissions.includes("update:view"));
  const denied = await request(server, { method: "POST", path: `/api/v1/admin/updates/plans/${planId}/execute`, headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(denied.status, 401);
  const executed = await request(server, { method: "POST", path: `/api/v1/admin/updates/plans/${planId}/execute`, headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-forwarded-proto": "https" }, body: JSON.stringify({ expected_revision: 1, confirmation: `APPLY ${planId}` }) });
  assert.equal(executed.status, 200); assert.equal(JSON.parse(executed.text).body.expected_revision, 1); assert.equal(calls.length, 2);
});

test("serves offline media inventory and CSRF-protects discovery through the administrator boundary", async (t) => {
  const calls = [];
  const offlineMediaApi = {
    matches(method, pathname) {
      return (method === "GET" && pathname === "/api/v1/admin/source-center/offline-media")
        || (method === "POST" && pathname === "/api/v1/admin/source-center/offline-media/discover");
    },
    async handle({ method, body, context }) {
      calls.push({ method, body, permissions: context.permissions });
      return { kind: "json", status: 200, body: method === "GET" ? { object: "list", data: [] } : { object: "list", data: [{ nodeId: body.nodeId }] } };
    },
  };
  const { server } = await fixture({ offlineMediaApi }); t.after(() => server.close());
  const signedIn = await request(server, { method: "POST", path: "/api/auth/sign-in", headers: { "content-type": "application/json", origin: publicOrigin, "x-forwarded-proto": "https" }, body: JSON.stringify({ loginName: "owner", password: ownerPassword }) });
  const session = JSON.parse(signedIn.text), cookie = signedIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const inventory = await request(server, { path: "/api/v1/admin/source-center/offline-media", headers: { cookie, "x-forwarded-proto": "https" } });
  assert.equal(inventory.status, 200); assert.deepEqual(JSON.parse(inventory.text), { object: "list", data: [] });
  const body = JSON.stringify({ nodeId: "018f6f18-24d7-7c21-9b62-8c0174199501" });
  const denied = await request(server, { method: "POST", path: "/api/v1/admin/source-center/offline-media/discover", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https" }, body });
  assert.equal(denied.status, 401);
  const accepted = await request(server, { method: "POST", path: "/api/v1/admin/source-center/offline-media/discover", headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-forwarded-proto": "https", "x-csrf-token": session.csrfToken }, body });
  assert.equal(accepted.status, 200); assert.equal(calls.length, 2); assert.ok(calls.every((item) => item.permissions.includes("source:view")));
});

test("requires HTTPS and same-origin before creating a browser session", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const body = JSON.stringify({ loginName: "owner", password: ownerPassword });
  const insecure = await request(server, {
    method: "POST",
    path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body,
  });
  assert.equal(insecure.status, 426);
  assert.equal(JSON.parse(insecure.text).error.code, "https_required");

  const crossOrigin = await request(server, {
    method: "POST",
    path: "/api/auth/sign-in",
    headers: { "content-type": "application/json", origin: "https://evil.test", "x-forwarded-proto": "https" },
    body,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.text).error.code, "origin_denied");
});

test("serves an authenticated session, CSRF preferences, SSE, WebSocket, and sign-out", async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const signIn = await request(server, {
    method: "POST",
    path: "/api/auth/sign-in",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "user-agent": "Contract Browser",
      "x-forwarded-for": "lan-contract-client",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }),
  });
  assert.equal(signIn.status, 200);
  const signedIn = JSON.parse(signIn.text);
  assert.equal(signedIn.authenticated, true);
  assert.match(signedIn.csrfToken, /^[A-Za-z0-9_-]{32,256}$/);
  assert.ok(signedIn.permissions.includes("identity:manage"));
  assert.equal(signedIn.teamRoles["team.default"], "manager");
  assert.equal(signedIn.teamMemberships.some((membership) => membership.teamKey === "team.default" && membership.roleKey === "team_admin"), true);
  const setCookies = signIn.headers["set-cookie"];
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.every((cookie) => /Secure; SameSite=Strict/.test(cookie)));
  assert.match(setCookies[0], /HttpOnly/);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");

  const session = await request(server, {
    path: "/api/auth/session",
    headers: { cookie, "x-forwarded-proto": "https" },
  });
  assert.equal(session.status, 200);
  const activeSession = JSON.parse(session.text);
  assert.equal(activeSession.identity.loginName, "owner");
  assert.equal(activeSession.teamRoles["team.default"], "manager");
  assert.equal(activeSession.teamMemberships.some((membership) => membership.teamKey === "team.default" && membership.roleKey === "team_admin"), true);

  const badCsrf = await request(server, {
    method: "PATCH",
    path: "/api/preferences/theme",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": "A".repeat(43),
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ theme: "dark" }),
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(JSON.parse(badCsrf.text).error.code, "csrf_failed");

  const locale = await request(server, {
    method: "PATCH",
    path: "/api/preferences/locale",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": signedIn.csrfToken,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ locale: "en" }),
  });
  assert.equal(locale.status, 200, locale.text);
  assert.equal(JSON.parse(locale.text).preferredLocale, "en");

  const events = await request(server, {
    path: "/events/session?once=1",
    headers: { cookie, "x-forwarded-proto": "https" },
  });
  assert.equal(events.status, 200);
  assert.match(events.headers["content-type"], /^text\/event-stream/);
  assert.match(events.text, /event: session\.ready/);

  const upgraded = await websocket(server, {
    cookie,
    origin: publicOrigin,
    "x-forwarded-proto": "https",
  });
  assert.equal(upgraded.status, 101);
  assert.equal(upgraded.payload[0], 0x81);
  assert.match(upgraded.payload.subarray(2).toString("utf8"), /session\.ready/);

  const signOut = await request(server, {
    method: "POST",
    path: "/api/auth/sign-out",
    headers: {
      cookie,
      origin: publicOrigin,
      "x-csrf-token": signedIn.csrfToken,
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(signOut.status, 200);
  assert.ok(signOut.headers["set-cookie"].every((value) => /Max-Age=0/.test(value)));
  const expired = await request(server, {
    path: "/api/auth/session",
    headers: { cookie, "x-forwarded-proto": "https" },
  });
  assert.equal(expired.status, 401);
});

test("flushes authenticated SSE headers before an idle application stream yields an event", async (t) => {
  const messagingApi = {
    matches(method, pathname) {
      return method === "GET" && pathname === "/api/v1/messaging/events";
    },
    async handle({ signal }) {
      return {
        kind: "sse",
        status: 200,
        events: (async function* idleEvents() {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })(),
        doneMarker: null,
      };
    },
  };
  const { server } = await fixture({ messagingApi });
  t.after(() => server.close());
  const signIn = await request(server, {
    method: "POST",
    path: "/api/auth/sign-in",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ loginName: "owner", password: ownerPassword }),
  });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
  const address = server.address();
  const responseHeaders = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("idle SSE response headers were not flushed")), 1_000);
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/v1/messaging/events?after=0",
      headers: { cookie, "x-forwarded-proto": "https" },
    }, (response) => {
      clearTimeout(timeout);
      resolve(response.headers);
      response.destroy();
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  assert.match(responseHeaders["content-type"], /^text\/event-stream/);
  assert.equal(responseHeaders["x-accel-buffering"], "no");
});
