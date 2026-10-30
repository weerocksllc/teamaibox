import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStaticApplicationPluginServer } from "../src/static-server.mjs";

test("static plugin CSS preserves the native hidden-state contract", async (context) => {
  const publicRoot = await mkdtemp(join(tmpdir(), "teamaibox-plugin-runtime-"));
  await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>fixture</title>");
  await writeFile(join(publicRoot, "app.css"), ".panel{display:grid}");

  const server = createStaticApplicationPluginServer({
    pluginId: "official.fixture",
    version: "0.1.0",
    publicRoot,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(publicRoot, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/plugins/official.fixture/app.css`);
  const css = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(css, /^\[hidden\]\{display:none!important\}\n/);
  assert.match(css, /\.panel\{display:grid\}/);
  assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(css));

  const head = await fetch(`${origin}/plugins/official.fixture/app.css`, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(css));
  assert.equal(await head.text(), "");

  const html = await (await fetch(`${origin}/plugins/official.fixture`)).text();
  assert.equal(html, "<!doctype html><title>fixture</title>");

  const preferences = await fetch(`${origin}/plugins/official.fixture/preferences-v1.mjs`);
  assert.equal(preferences.status, 200);
  assert.equal(preferences.headers.get("cache-control"), "no-cache");
  assert.match(preferences.headers.get("content-type"), /text\/javascript/);
  assert.match(await preferences.text(), /export function applyPluginPreferenceSnapshotV1/);

  const aliases = await fetch(`${origin}/plugins/official.fixture/platform-preferences.css`);
  assert.equal(aliases.status, 200);
  assert.equal(aliases.headers.get("cache-control"), "no-cache");
  assert.match(await aliases.text(), /--bg:var\(--teamaibox-canvas\)/);
});

test("stable module URLs revalidate after a deployment instead of mixing old JS with new HTML", async (context) => {
  const publicRoot = await mkdtemp(join(tmpdir(), "teamaibox-plugin-update-"));
  await writeFile(join(publicRoot, "index.html"), '<script type="module" src="app.js"></script>');
  await writeFile(join(publicRoot, "app.js"), 'export const generation = "old";');
  const server = createStaticApplicationPluginServer({ pluginId: "official.fixture", version: "0.1.0", publicRoot });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(publicRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}/plugins/official.fixture`;
  const first = await fetch(`${origin}/app.js`);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  assert.match(await first.text(), /"old"/);
  await writeFile(join(publicRoot, "app.js"), 'export const generation = "new";');
  const next = await fetch(`${origin}/app.js`);
  assert.equal(next.headers.get("cache-control"), "no-cache");
  assert.match(await next.text(), /"new"/);
  const html = await fetch(origin);
  assert.equal(html.headers.get("cache-control"), "no-store");
  await html.text();
  const head = await fetch(`${origin}/object-upload.mjs`, { method: "HEAD" });
  assert.equal(head.headers.get("cache-control"), "no-cache");
  assert.equal(await head.text(), "");
});
