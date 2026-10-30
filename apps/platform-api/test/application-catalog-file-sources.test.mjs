import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileApplicationRouteSource } from "../src/applications/file-application-route-source.mjs";
import { FileBuiltInApplicationSource } from "../src/applications/file-built-in-application-source.mjs";
import { CompositeApplicationRouteSource } from "../src/applications/composite-application-route-source.mjs";

test("probes only validated fixed origins, bounds readiness responses, and checks plugin identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "routes.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, routes: [{ pluginId: "official.ocr", pathPrefix: "/plugins/official.ocr", origin: "http://ocr-plugin:8080" }] }));
  for (const body of [{ status: "ready", pluginId: "official.ocr", version: "0.1.0" },
    { status: "ready", pluginId: "wrong.plugin", version: "0.1.0" }, { padding: "x".repeat(4097) }]) {
    const source = new FileApplicationRouteSource({ path, readinessFetcher: async (url, init) => {
      assert.equal(String(url), "http://ocr-plugin:8080/health/ready");
      assert.equal(init.redirect, "error"); assert.ok(init.signal);
      return Response.json(body);
    } });
    const [route] = await source.routes();
    assert.equal(route.healthy, body.pluginId === "official.ocr");
    assert.equal(route.readinessChecked, true); assert.equal(route.origin, undefined);
  }
  const source = new FileApplicationRouteSource({ path, readinessFetcher: async () => { throw new Error("private origin"); } });
  assert.equal((await source.routes())[0].healthy, false);
});

test("route and built-in release files are strict immutable inputs to catalog evaluation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-app-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routesPath = join(directory, "routes.json"), builtInsPath = join(directory, "built-ins.json");
  await writeFile(routesPath, JSON.stringify({ schemaVersion: 1, routes: [{ pluginId: "example.notes", pathPrefix: "/plugins/example.notes", origin: "http://notes:8080" }] }));
  await writeFile(builtInsPath, JSON.stringify({ schemaVersion: 1, applications: [{
    applicationKey: "official.assistant", installedVersion: "0.1.0",
    route: { pathPrefix: "/apps/assistant", integration: "workbench" },
    requiredPermissions: ["ai:invoke"], requiredCapabilities: ["chat"],
    requiredModelProfiles: { chat: "llm.qwen38.nvfp4" }, requiredCoreServices: ["platform-api"], ui: {},
  }] }));
  assert.equal((await new FileApplicationRouteSource({ path: routesPath }).routes())[0].pluginKey, "example.notes");
  const builtIn = (await new FileBuiltInApplicationSource({ path: builtInsPath }).applications())[0];
  assert.equal(builtIn.applicationKey, "official.assistant");
  assert.equal(builtIn.requiredModelProfiles.chat, "llm.qwen38.nvfp4");
  await writeFile(builtInsPath, JSON.stringify({ schemaVersion: 1, applications: [{ ...builtIn,
    requiredModelProfiles: { translation: "llm.qwen36.nvfp4" } }] }));
  await assert.rejects(new FileBuiltInApplicationSource({ path: builtInsPath }).applications(), /profile requirements are invalid/);
  await writeFile(routesPath, JSON.stringify({ schemaVersion: 1, routes: [{ pluginId: "example.notes", pathPrefix: "/plugins/wrong", origin: "http://notes:8080" }] }));
  await assert.rejects(new FileApplicationRouteSource({ path: routesPath }).routes(), /route entry is invalid/);
});

test("composes fixed and live routes, delegates content, and rejects identity collisions", async () => {
  const fixed = { async routes() { return [{ pluginKey: "official.notes", pathPrefix: "/plugins/official.notes" }]; } };
  const live = { async routes() { return [{ pluginKey: "example.notes", pathPrefix: "/plugins/example.notes", transport: "node-agent-mtls-proxy" }]; },
    async fetch({ pluginKey }) { return pluginKey === "example.notes" ? { status: 200, headers: {}, body: Buffer.from("ready") } : null; } };
  const composite = new CompositeApplicationRouteSource({ sources: [fixed, live] });
  assert.deepEqual((await composite.routes()).map((item) => item.pluginKey), ["official.notes", "example.notes"]);
  assert.equal((await composite.fetch({ pluginKey: "example.notes", method: "GET", path: "/plugins/example.notes" })).body.toString(), "ready");
  await assert.rejects(new CompositeApplicationRouteSource({ sources: [fixed, fixed] }).routes(), /Duplicate application route/);
});

test("a targeted route never probes unrelated application services", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-targeted-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "routes.json"), calls = [];
  await writeFile(path, JSON.stringify({ schemaVersion: 1, routes: ["official.ocr", "official.notes"].map((key) => ({
    pluginId: key, pathPrefix: `/plugins/${key}`, origin: `http://${key}:8080`,
  })) }));
  const source = new FileApplicationRouteSource({ path, readinessFetcher: async (url) => {
    calls.push(String(url)); return Response.json({ status: "ready", pluginId: "official.notes", version: "1.0.0" });
  } });
  const composite = new CompositeApplicationRouteSource({ sources: [source] });
  const routes = await composite.routes({ pluginKey: "official.notes" });
  assert.deepEqual(calls, ["http://official.notes:8080/health/ready"]);
  assert.deepEqual(routes.map((r) => r.pluginKey), ["official.notes"]);
});
