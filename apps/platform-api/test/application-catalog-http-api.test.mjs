import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationCatalogHttpApi, matchesApplicationCatalogHttpRoute } from "../src/applications/application-catalog-http-api.mjs";

test("exposes the authenticated read-only application catalog endpoint", async () => {
  const calls = [];
  const api = new ApplicationCatalogHttpApi({ service: {
    async list(input) { calls.push(input); return { schemaVersion: 1, applications: [] }; },
    async resolveProxyRoute() { return null; },
    async fetchProxyContent() { return null; },
  } });
  assert.equal(matchesApplicationCatalogHttpRoute("GET", "/api/v1/applications"), true);
  assert.equal(matchesApplicationCatalogHttpRoute("POST", "/api/v1/applications"), false);
  const context = { identity: { id: "owner" }, permissions: ["application:catalog:view"] };
  const result = await api.handle({ method: "GET", pathname: "/api/v1/applications", context });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ context }]);
});

test("resolves and fetches an authenticated runtime route without exposing a worker origin", async () => {
  const expected = { schemaVersion: 1, pluginId: "example.notes", pathPrefix: "/plugins/example.notes", integration: "iframe", transport: "platform-authenticated-proxy" };
  const api = new ApplicationCatalogHttpApi({ service: {
    async list() { return { schemaVersion: 1, applications: [] }; },
    async resolveProxyRoute({ pluginKey }) { return pluginKey === "example.notes" ? expected : null; },
    async fetchProxyContent({ pluginKey }) { return pluginKey === "example.notes"
      ? { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("ready") } : null; },
  } });
  assert.equal(matchesApplicationCatalogHttpRoute("GET", "/internal/v1/plugin-routes/example.notes"), true);
  assert.deepEqual((await api.handle({ method: "GET", pathname: "/internal/v1/plugin-routes/example.notes", context: {} })).body, expected);
  const content = await api.handle({ method: "GET", pathname: "/plugins/example.notes", target: "/plugins/example.notes?theme=dark", context: {} });
  assert.equal(content.kind, "bytes");
  assert.equal(content.body.toString(), "ready");
  await assert.rejects(api.handle({ method: "GET", pathname: "/internal/v1/plugin-routes/example.missing", context: {} }), (error) => error.code === "plugin_route_unavailable" && error.status === 404);
});
