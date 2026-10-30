import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createWebBoundary,
  loadWebBoundaryConfiguration,
  WebBoundaryError,
  redactWebLogFields,
} from "../server/web-boundary.mjs";

test("casting signalling handles never enter HTTP or WebSocket request logs", () => {
  for (const suffix of ["/rtc", "/rtc/v1", "/rtc/validate", "/rtc/v1/validate"]) {
    const fields = { path: "/api/v1/casting/media/" + "h".repeat(43) + suffix, status: 404 };
    assert.deepEqual(redactWebLogFields(fields), { path: "/api/v1/casting/media/[redacted]", status: 404 });
    assert.ok(fields.path.includes("h".repeat(43)), "input is not mutated");
  }
  assert.deepEqual(redactWebLogFields({ path: "/health/ready", status: 200 }), { path: "/health/ready", status: 200 });
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-web-boundary-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Team AI Box test</title><div id=\"root\"></div>");
  await writeFile(join(root, "assets", "app.12345678.js"), "globalThis.fixtureLoaded=true;");
  return root;
}

function tlsFixture(root, { ca = false, dnsName, label }) {
  const certificateFile = join(root, `${label}.crt`);
  const keyFile = join(root, `${label}.key`);
  const arguments_ = [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile,
    "-out", certificateFile,
    "-days", "2",
    "-subj", `/CN=${dnsName}`,
    "-addext", `subjectAltName=DNS:${dnsName}`,
    "-addext", `basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}`,
  ];
  if (!ca) arguments_.push("-addext", "extendedKeyUsage=serverAuth");
  execFileSync("openssl", arguments_, { stdio: "ignore" });
  return { certificateFile, keyFile };
}

function releaseEnvironment({ certificateFile, keyFile, platformApiOrigin, port, publicHost = "appliance.test", root }) {
  return {
    WEB_DEPLOYMENT_SLOT: "edge",
    WEB_HOST: "127.0.0.1",
    WEB_MODE: "release",
    WEB_PORT: String(port),
    WEB_PUBLIC_ORIGIN: `https://${publicHost}:${port}`,
    WEB_RELEASE_ID: "release-test",
    WEB_STATIC_ROOT: root,
    WEB_TLS_CERT_FILE: certificateFile,
    WEB_TLS_KEY_FILE: keyFile,
    PLATFORM_API_ORIGIN: platformApiOrigin,
  };
}

async function startUpstream() {
  const port = await freePort();
  const connections = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/api/delayed") {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"delayed":true}');
      }, 50);
      return;
    }
    if (request.url === "/api/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ready\ndata: one\n\n");
      setTimeout(() => response.end("event: done\ndata: two\n\n"), 5);
      return;
    }
    if (request.url === "/api/idle-stream") {
      response.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      response.flushHeaders();
      request.once("close", () => response.destroy());
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        authorization: request.headers.authorization || null,
        body: Buffer.concat(chunks).toString("utf8"),
        cookie: request.headers.cookie || null,
        forwardedProto: request.headers["x-forwarded-proto"],
        origin: request.headers.origin || null,
        requestId: request.headers["x-request-id"],
      }));
    });
  });
  server.on("upgrade", (request, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupstream-ready");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of connections) socket.destroy();
      await closed;
    },
  };
}

async function startBoundary(root, upstream, additionalEnvironment = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const boundary = await createWebBoundary({
    environment: {
      WEB_ALLOW_INSECURE_HTTP: "true",
      WEB_DEPLOYMENT_SLOT: "green",
      WEB_DEVELOPMENT_DEMO: "true",
      WEB_DEVELOPMENT_PERMISSIONS: "ai:invoke,node:manage,object_reference:revoke:any",
      WEB_HOST: "127.0.0.1",
      WEB_MODE: "development",
      WEB_PORT: String(port),
      WEB_PUBLIC_ORIGIN: origin,
      WEB_RELEASE_ID: "test-release",
      WEB_STATIC_ROOT: root,
      PLATFORM_API_ORIGIN: upstream.origin,
      ...additionalEnvironment,
    },
  });
  await boundary.listen();
  return { boundary, origin };
}

test("rejects release HTTP and partially configured TLS", () => {
  assert.throws(
    () => loadWebBoundaryConfiguration({ WEB_MODE: "release" }),
    (error) => error instanceof WebBoundaryError && error.code === "https_required",
  );
  assert.throws(
    () => loadWebBoundaryConfiguration({
      WEB_MODE: "release",
      WEB_TLS_CERT_FILE: "/run/tls/cert.pem",
      WEB_PUBLIC_ORIGIN: "https://appliance.example",
    }),
    (error) => error instanceof WebBoundaryError && error.code === "invalid_configuration",
  );
});

test("synthetic-only preview fails closed around proxy routes and credentials", async () => {
  assert.throws(
    () => loadWebBoundaryConfiguration({
      WEB_ALLOW_INSECURE_HTTP: "true",
      WEB_DEVELOPMENT_SYNTHETIC_ONLY: "true",
      WEB_MODE: "development",
    }),
    (error) => error instanceof WebBoundaryError && error.code === "invalid_configuration",
  );
  assert.throws(
    () => loadWebBoundaryConfiguration({
      WEB_ALLOW_INSECURE_HTTP: "true",
      WEB_APPLICATION_ORIGIN: "http://application:8080",
      WEB_DEVELOPMENT_DEMO: "true",
      WEB_DEVELOPMENT_SYNTHETIC_ONLY: "true",
      WEB_MODE: "development",
    }),
    (error) => error instanceof WebBoundaryError && error.code === "invalid_configuration",
  );

  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const { boundary, origin } = await startBoundary(root, upstream, { WEB_DEVELOPMENT_SYNTHETIC_ONLY: "true" });
  try {
    const runtime = await fetch(`${origin}/runtime-config.js`).then((response) => response.text());
    assert.match(runtime, /isolated-development-synthetic-only/);
    assert.match(runtime, /releaseEvidenceEligible\":false/);
    const proxy = await fetch(`${origin}/api/v1/admin/nodes`);
    assert.equal(proxy.status, 403);
    assert.equal((await proxy.json()).error.code, "preview_synthetic_only");
    const credentialed = await fetch(`${origin}/`, { headers: { authorization: "Bearer synthetic-test" } });
    assert.equal(credentialed.status, 400);
    assert.equal((await credentialed.json()).error.code, "preview_credentials_rejected");
  } finally {
    await boundary.close();
    await upstream.close();
  }
});

test("release boundary accepts a bounded long-running control timeout", () => {
  const config = loadWebBoundaryConfiguration({
    WEB_MODE: "release",
    WEB_TLS_CERT_FILE: "/run/tls/cert.pem",
    WEB_TLS_KEY_FILE: "/run/tls/key.pem",
    WEB_PUBLIC_ORIGIN: "https://appliance.example",
    WEB_UPSTREAM_TIMEOUT_MS: "240000",
  });
  assert.equal(config.requestTimeoutMs, 240_000);
  assert.throws(
    () => loadWebBoundaryConfiguration({
      WEB_MODE: "release",
      WEB_TLS_CERT_FILE: "/run/tls/cert.pem",
      WEB_TLS_KEY_FILE: "/run/tls/key.pem",
      WEB_PUBLIC_ORIGIN: "https://appliance.example",
      WEB_UPSTREAM_TIMEOUT_MS: "300001",
    }),
    (error) => error instanceof WebBoundaryError && error.code === "invalid_configuration",
  );
});

test("release TLS requires a matching server leaf and private key", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const valid = tlsFixture(root, { dnsName: "appliance.test", label: "valid" });
  const wrongHost = tlsFixture(root, { dnsName: "wrong.test", label: "wrong-host" });
  const caLeaf = tlsFixture(root, { ca: true, dnsName: "appliance.test", label: "ca-leaf" });
  try {
    const port = await freePort();
    const boundary = await createWebBoundary({ environment: releaseEnvironment({ ...valid, platformApiOrigin: upstream.origin, port, root }) });
    await boundary.listen();
    try {
      const response = await new Promise((resolve, reject) => {
        const request = httpsRequest({ host: "127.0.0.1", port, path: "/health/ready", rejectUnauthorized: false }, resolve);
        request.once("error", reject);
        request.end();
      });
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).transport, "https");
      assert.match(response.headers["strict-transport-security"], /max-age=31536000/);
    } finally { await boundary.close(); }

    const wrongHostPort = await freePort();
    const caLeafPort = await freePort();
    const mismatchedKeyPort = await freePort();
    await assert.rejects(
      () => createWebBoundary({ environment: releaseEnvironment({ ...wrongHost, platformApiOrigin: upstream.origin, port: wrongHostPort, root }) }),
      (error) => error instanceof WebBoundaryError && error.code === "invalid_certificate" && /does not match/.test(error.message),
    );
    await assert.rejects(
      () => createWebBoundary({ environment: releaseEnvironment({ ...caLeaf, platformApiOrigin: upstream.origin, port: caLeafPort, root }) }),
      (error) => error instanceof WebBoundaryError && error.code === "invalid_certificate" && /server leaf/.test(error.message),
    );
    await assert.rejects(
      () => createWebBoundary({ environment: releaseEnvironment({ certificateFile: valid.certificateFile, keyFile: wrongHost.keyFile, platformApiOrigin: upstream.origin, port: mismatchedKeyPort, root }) }),
      (error) => error instanceof WebBoundaryError && error.code === "invalid_certificate" && /secure context/.test(error.message),
    );
  } finally {
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test("an invalid TLS reload preserves the active secure context", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const active = tlsFixture(root, { dnsName: "appliance.test", label: "reload-active" });
  const invalid = tlsFixture(root, { dnsName: "wrong.test", label: "reload-invalid" });
  const port = await freePort();
  let boundary;
  try {
    boundary = await createWebBoundary({ environment: releaseEnvironment({ ...active, platformApiOrigin: upstream.origin, port, root }) });
    await boundary.listen();
    await copyFile(invalid.certificateFile, active.certificateFile);
    await copyFile(invalid.keyFile, active.keyFile);
    await assert.rejects(
      () => boundary.reloadTls(),
      (error) => error instanceof WebBoundaryError && error.code === "invalid_certificate" && /does not match/.test(error.message),
    );
    const response = await new Promise((resolve, reject) => {
      const request = httpsRequest({ host: "127.0.0.1", port, path: "/health/ready", rejectUnauthorized: false }, resolve);
      request.once("error", reject);
      request.end();
    });
    response.resume();
    await new Promise((resolve) => response.once("end", resolve));
    assert.equal(response.statusCode, 200);
  } finally {
    if (boundary) await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test("serves health, runtime bootstrap, immutable assets, and SPA fallback with security headers", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const { boundary, origin } = await startBoundary(root, upstream);
  try {
    const health = await fetch(origin + "/health/ready");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ready",
      releaseId: "test-release",
      slot: "green",
      transport: "http",
      certificateNotAfter: null,
    });
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("strict-transport-security"), null);

    const runtime = await fetch(origin + "/runtime-config.js");
    const runtimeSource = await runtime.text();
    assert.match(runtimeSource, /test-release/);
    assert.match(runtimeSource, /ai:invoke/);
    assert.match(runtimeSource, /object_reference:revoke:any/);
    assert.equal(runtime.headers.get("cache-control"), "no-store");

    const asset = await fetch(origin + "/assets/app.12345678.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const spa = await fetch(origin + "/admin/nodes", { headers: { accept: "text/html" } });
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /Team AI Box test/);
    assert.equal(spa.headers.get("cache-control"), "no-store");

    const dottedPluginDeepLink = await fetch(origin + "/apps/example.team-notes", { headers: { accept: "text/html" } });
    assert.equal(dottedPluginDeepLink.status, 200);
    assert.match(await dottedPluginDeepLink.text(), /Team AI Box test/);
    assert.equal(dottedPluginDeepLink.headers.get("cache-control"), "no-store");

    const missing = await fetch(origin + "/missing.js");
    assert.equal(missing.status, 404);
  } finally {
    await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test("a browser navigation that closes a pending proxy response cannot terminate the Web boundary", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const { boundary, origin } = await startBoundary(root, upstream);
  try {
    const target = new URL("/api/delayed", origin);
    const request = httpRequest({ host: target.hostname, port: target.port, path: target.pathname });
    request.on("error", () => {});
    request.end();
    await new Promise((resolve) => setTimeout(resolve, 5));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await fetch(origin + "/health/ready");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ready");
  } finally {
    await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test("streams API/SSE, preserves request IDs, and rejects a cross-origin state change", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const { boundary, origin } = await startBoundary(root, upstream);
  try {
    const stream = await fetch(origin + "/api/stream");
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    assert.match(await stream.text(), /event: ready[\s\S]*event: done/);

    const idle = new URL("/api/idle-stream", origin);
    const idleHeaders = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("idle SSE proxy headers were not flushed")), 1_000);
      const outgoing = httpRequest({ host: idle.hostname, port: idle.port, path: idle.pathname }, (response) => {
        clearTimeout(timer);
        resolve(response.headers);
        response.destroy();
      });
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(idleHeaders["content-type"], "text/event-stream");
    assert.equal(idleHeaders["x-accel-buffering"], "no");

    const proxied = await fetch(origin + "/api/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", origin, "x-request-id": "request-test-1234" },
      body: "payload",
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), {
      authorization: null,
      body: "payload",
      cookie: null,
      forwardedProto: "http",
      origin,
      requestId: "request-test-1234",
    });

    const rejected = await fetch(origin + "/api/echo", {
      method: "POST",
      headers: { origin: "https://untrusted.example" },
      body: "blocked",
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "origin_rejected");
  } finally {
    await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test("proxies only configured plugin GET routes and strips browser credentials", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const routesFile = join(root, "plugin-routes.json");
  await writeFile(routesFile, JSON.stringify({
    schemaVersion: 1,
    routes: [{
      pluginId: "official.drawing",
      pathPrefix: "/plugins/official.drawing",
      origin: upstream.origin,
    }],
  }));
  const { boundary, origin } = await startBoundary(root, upstream, {
    WEB_PLUGIN_ROUTES_FILE: routesFile,
  });
  try {
    const response = await fetch(origin + "/plugins/official.drawing/app.js", {
      headers: {
        authorization: "Bearer must-not-leak",
        cookie: "session=must-not-leak",
        origin,
        referer: origin + "/",
        "x-csrf-token": "must-not-leak",
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.authorization, null);
    assert.equal(body.cookie, null);
    assert.equal(body.origin, null);
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);

    const rejected = await fetch(origin + "/plugins/official.drawing", { method: "POST" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET, HEAD");

    const unrelated = await fetch(origin + "/plugins/unconfigured/app.js");
    assert.equal(unrelated.status, 404);
  } finally {
    await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});

test('only the exact virtual-phone plugin receives camera delegation; the shell permits it without granting user consent',async()=>{
  const root=await fixtureRoot(),upstream=await startUpstream(),routesFile=join(root,'phone-camera-routes.json');
  await writeFile(routesFile,JSON.stringify({schemaVersion:1,routes:['official.virtual-phones','example.phone-camera'].map(pluginId=>({pluginId,pathPrefix:'/plugins/'+pluginId,origin:upstream.origin}))}));
  const {boundary,origin}=await startBoundary(root,upstream,{WEB_PLUGIN_ROUTES_FILE:routesFile});
  try{
    const shell=await fetch(origin+'/');assert.match(shell.headers.get('permissions-policy'),/camera=\(self\)/);
    const phone=await fetch(origin+'/plugins/official.virtual-phones');assert.equal(phone.status,200);assert.match(phone.headers.get('permissions-policy'),/camera=\(self\)/);
    const other=await fetch(origin+'/plugins/example.phone-camera');assert.equal(other.status,200);assert.match(other.headers.get('permissions-policy'),/camera=\(\)/);
  }finally{await boundary.close();await upstream.close();await rm(root,{recursive:true});}
});

test("resolves a live ApplicationPlugin through the authenticated platform proxy without exposing a LAN origin", async () => {
  const root = await fixtureRoot();
  const resolverPort = await freePort();
  const resolverFacts = [];
  const resolver = createServer((request, response) => {
    resolverFacts.push({ url: request.url, cookie: request.headers.cookie, forwardedProto: request.headers["x-forwarded-proto"] });
    if (request.url === "/internal/v1/plugin-routes/example.team-notes" && request.headers.cookie === "session=owner") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, pluginId: "example.team-notes", pathPrefix: "/plugins/example.team-notes", integration: "iframe", transport: "platform-authenticated-proxy" }));
      return;
    }
    if (request.url === "/plugins/example.team-notes" && request.headers.cookie === "session=owner") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ fetchedThroughNodeAgent: true, pluginReceivedCookie: false, pluginReceivedAuthorization: false }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":{"code":"plugin_route_unavailable"}}');
  });
  await new Promise((resolve, reject) => resolver.listen(resolverPort, "127.0.0.1", resolve).once("error", reject));
  const control = { origin: `http://127.0.0.1:${resolverPort}` };
  const { boundary, origin } = await startBoundary(root, control);
  try {
    const response = await fetch(origin + "/plugins/example.team-notes", { headers: {
      authorization: "Bearer must-not-leak", cookie: "session=owner", origin, "x-csrf-token": "must-not-leak",
    } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { fetchedThroughNodeAgent: true, pluginReceivedCookie: false, pluginReceivedAuthorization: false });
    assert.deepEqual(resolverFacts, [
      { url: "/internal/v1/plugin-routes/example.team-notes", cookie: "session=owner", forwardedProto: "http" },
      { url: "/plugins/example.team-notes", cookie: "session=owner", forwardedProto: "http" },
    ]);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'self'/);

    const denied = await fetch(origin + "/plugins/example.team-notes");
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error.code, "plugin_route_unavailable");
  } finally {
    await boundary.close();
    await new Promise((resolve, reject) => resolver.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true });
  }
});

test("an expired plugin session reports sign-in rather than a missing application", async () => {
  const root = await fixtureRoot(), resolverPort = await freePort();
  const resolver = createServer((request, response) => {
    response.writeHead(request.headers.cookie === "session=forbidden" ? 403 : 401);
    response.end('{"error":{"code":"invalid_session"}}');
  });
  await new Promise(resolve => resolver.listen(resolverPort, "127.0.0.1", resolve));
  const { boundary, origin } = await startBoundary(root, { origin: `http://127.0.0.1:${resolverPort}` });
  try {
    const json = await fetch(origin + "/plugins/example.notes");
    assert.equal(json.status, 401); assert.equal((await json.json()).error.code, "invalid_session");
    const html = await fetch(origin + "/plugins/example.notes", { headers: { accept: "text/html" } });
    assert.equal(html.status, 401); assert.match(html.headers.get("content-type"), /text\/html/);
    assert.equal(html.headers.get("cache-control"), "no-store");
    assert.equal(html.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    assert.match(await html.text(), /请重新登录.*href="\/" target="_top"/s);
    const english = await fetch(origin + "/plugins/example.notes?locale=en", { headers: { accept: "text/html" } });
    assert.match(await english.text(), /Please sign in again/);
    const head = await fetch(origin + "/plugins/example.notes", { method: "HEAD", headers: { accept: "text/html" } });
    assert.equal(head.status, 401); assert.equal(await head.text(), "");
    const forbidden = await fetch(origin + "/plugins/example.notes", { headers: { cookie: "session=forbidden" } });
    assert.equal(forbidden.status, 404); assert.equal((await forbidden.json()).error.code, "plugin_route_unavailable");
  } finally {
    await boundary.close(); await new Promise(resolve => resolver.close(resolve)); await rm(root, { recursive: true });
  }
});

test("rejects malformed plugin route configuration", async () => {
  const root = await fixtureRoot();
  const routesFile = join(root, "plugin-routes.json");
  await writeFile(routesFile, JSON.stringify({
    schemaVersion: 1,
    routes: [{ pluginId: "official.drawing", pathPrefix: "/plugins/wrong", origin: "http://drawing:8080" }],
  }));
  await assert.rejects(
    () => createWebBoundary({
      environment: {
        WEB_ALLOW_INSECURE_HTTP: "true",
        WEB_MODE: "development",
        WEB_PLUGIN_ROUTES_FILE: routesFile,
        WEB_STATIC_ROOT: root,
      },
    }),
    (error) => error instanceof WebBoundaryError && error.code === "invalid_plugin_routes",
  );
  await rm(root, { recursive: true });
});

test("unavailable plugin page shows a localized retry link without changing JSON errors", async () => {
  const root = await fixtureRoot(), upstream = await startUpstream();
  const routesFile = join(root, "unavailable-plugin.json");
  await writeFile(routesFile, JSON.stringify({schemaVersion:1,routes:[{pluginId:"example.notes",pathPrefix:"/plugins/example.notes",origin:upstream.origin}]}));
  const {boundary, origin} = await startBoundary(root, upstream, {WEB_PLUGIN_ROUTES_FILE:routesFile});
  await upstream.close();
  try {
    const json = await fetch(origin + "/plugins/example.notes");
    assert.equal(json.status, 502); assert.equal((await json.json()).error.code, "upstream_unavailable");
    for (const [locale, theme, text] of [["zh-CN","light","重新打开应用"],["en","dark","Reopen app"]]) {
      const response = await fetch(origin + `/plugins/example.notes?locale=${locale}&theme=${theme}`, {headers:{accept:"text/html"}});
      assert.equal(response.status,502); assert.match(response.headers.get("content-type"),/text\/html/);
      assert.equal(response.headers.get("cache-control"),"no-store");
      assert.equal(response.headers.get("x-frame-options"),"SAMEORIGIN");
      const html=await response.text();
      assert.ok(html.includes(text)); assert.ok(html.includes(`color-scheme:${theme}`));
      assert.match(html, /<a href="">/); assert.doesNotMatch(html, /<script|127\.0\.0\.1|session=/);
    }
    const head = await fetch(origin + "/plugins/example.notes", {method:"HEAD",headers:{accept:"text/html"}});
    assert.equal(head.status,502); assert.equal(await head.text(),"");
  } finally { await boundary.close(); await rm(root,{recursive:true}); }
});

test("proxies an allowed WebSocket upgrade path", async () => {
  const root = await fixtureRoot();
  const upstream = await startUpstream();
  const { boundary, origin } = await startBoundary(root, upstream);
  const url = new URL(origin);
  try {
    const received = await new Promise((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      let payload = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("WebSocket proxy response timed out"));
      }, 2_000);
      socket.on("connect", () => {
        socket.write(
          "GET /ws/test HTTP/1.1\r\n"
          + `Host: ${url.host}\r\n`
          + `Origin: ${origin}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => {
        payload += chunk.toString("utf8");
        if (payload.includes("upstream-ready")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(payload);
        }
      });
      socket.on("error", reject);
    });
    assert.match(received, /^HTTP\/1\.1 101/);
    assert.match(received, /upstream-ready/);
  } finally {
    await boundary.close();
    await upstream.close();
    await rm(root, { recursive: true });
  }
});
