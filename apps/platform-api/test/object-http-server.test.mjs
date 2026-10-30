import assert from "node:assert/strict";
import { test } from "node:test";

import { createPlatformApiServer } from "../server/platform-api.mjs";

async function startServer(objectApi, teamDriveApi = null) {
  const authentication = {
    async authenticateSession({ sessionToken, csrfToken, requireCsrf }) {
      assert.equal(sessionToken, "s".repeat(40));
      if (requireCsrf) assert.equal(csrfToken, "c".repeat(40));
      return {
        identityId: "11111111-1111-4111-8111-111111111111",
        identity: { id: "11111111-1111-4111-8111-111111111111", identityKind: "local_user" },
        permissions: ["file:read", "file:write", "ai:invoke"],
      };
    },
  };
  const server = createPlatformApiServer({
    authentication,
    preferences: {},
    publicOrigin: "https://box.test",
    objectApi,
    teamDriveApi,
    logger: { warn() {} },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const secureHeaders = {
  cookie: `__Host-teamaibox-session=${"s".repeat(40)}`,
  origin: "https://box.test",
  "x-csrf-token": "c".repeat(40),
  "x-forwarded-proto": "https",
};

test("platform transport reads bounded raw uploads and keeps object API authentication and CSRF", async () => {
  let received = null;
  const objectApi = {
    matches: (method, pathname) => method === "POST" && pathname === "/api/v1/objects/uploads",
    bodyKind: () => "bytes",
    async handle(input) {
      received = input;
      return { kind: "json", status: 201, body: { reference_id: "22222222-2222-4222-8222-222222222222" } };
    },
  };
  const fixture = await startServer(objectApi);
  try {
    const response = await fetch(fixture.origin + "/api/v1/objects/uploads?capability=ocr", {
      method: "POST",
      headers: { ...secureHeaders, "content-type": "image/png", "x-teamaibox-object-name": "scan.png" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).reference_id, "22222222-2222-4222-8222-222222222222");
    assert.deepEqual([...received.body], [0, 1, 2, 3]);
    assert.equal(received.query.get("capability"), "ocr");
    assert.equal(received.context.identityId, "11111111-1111-4111-8111-111111111111");
  } finally { await fixture.close(); }
});

test("platform transport streams protected object bytes without JSON coercion", async () => {
  const objectApi = {
    matches: (method, pathname) => method === "GET" && pathname.endsWith("/content"),
    bodyKind: () => "none",
    async handle() {
      return {
        kind: "bytes", status: 206, body: Buffer.from([4, 5, 6]),
        headers: { "content-type": "application/octet-stream", "content-range": "bytes 1-3/8" },
      };
    },
  };
  const fixture = await startServer(objectApi);
  try {
    const response = await fetch(fixture.origin + "/api/v1/objects/references/22222222-2222-4222-8222-222222222222/content", {
      headers: { cookie: secureHeaders.cookie, "x-forwarded-proto": "https" },
    });
    assert.equal(response.status, 206);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
    assert.equal(response.headers.get("content-range"), "bytes 1-3/8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally { await fixture.close(); }
});

test("platform transport protects Team Drive mutations with session, origin, CSRF, and bounded JSON", async () => {
  let received = null;
  const teamDriveApi = {
    matches: (method, pathname) => method === "POST" && pathname.endsWith("/folders"),
    bodyKind: () => "json",
    async handle(input) { received = input; return { kind: "json", status: 201, body: { object: "files.entry", name: input.body.name } }; },
  };
  const fixture = await startServer(null, teamDriveApi);
  try {
    const response = await fetch(fixture.origin + "/api/v1/files/roots/22222222-2222-4222-8222-222222222222/folders", {
      method: "POST",
      headers: { ...secureHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "资料" }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).name, "资料");
    assert.equal(received.context.identityId, "11111111-1111-4111-8111-111111111111");

    const denied = await fetch(fixture.origin + "/api/v1/files/roots/22222222-2222-4222-8222-222222222222/folders", {
      method: "POST",
      headers: { ...secureHeaders, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "denied" }),
    });
    assert.equal(denied.status, 403);
  } finally { await fixture.close(); }
});
