import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("external compute administration uses the protected provider lifecycle API", async () => {
  const client = await readFile(new URL("src/providers/external-provider-client.ts", root), "utf8");
  assert.match(client, /\/api\/v1\/admin\/providers/);
  assert.match(client, /x-csrf-token/);
  assert.match(client, /\/test`/);
  assert.match(client, /credential\/rotate/);
  assert.match(client, /enabled \? "enable" : "disable"/);
});

test("provider panel gates enablement on contract evidence and never hardcodes a lab endpoint", async () => {
  const panel = await readFile(new URL("src/providers/ExternalProvidersPanel.tsx", root), "utf8");
  assert.match(panel, /provider\.contract\.state !== "passed"/);
  assert.match(panel, /customCaPem/);
  assert.match(panel, /credentialConfigured/);
  assert.match(panel, /provider\.health\.latencyMilliseconds/);
  assert.doesNotMatch(panel, /192\.168\.10\.(18|20)/);
  assert.doesNotMatch(panel, /Bearer\s+[A-Za-z0-9_-]{8,}/);
});

test("provider administration is rendered only in its permission-filtered admin route", async () => {
  const app = await readFile(new URL("src/App.tsx", root), "utf8");
  assert.match(app, /selected\?\.id === "providers" && <ExternalProvidersPanel/);
  assert.match(app, /providers: "provider:manage"/);
});

test("large current routing-policy inventories cannot widen the administrator viewport", async () => {
  const styles = await readFile(new URL("src/styles.css", root), "utf8");
  assert.match(styles, /\.routing-policy-grid > article \{ min-width: 0;/);
  assert.match(styles, /\.routing-policy-grid > article > header > div \{ min-width: 0; \}/);
  assert.match(styles, /\.routing-policy-grid code,[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.routing-policy-grid em \{[^}]*min-width: 0;[^}]*max-width: 45%;[^}]*overflow-wrap: anywhere;/);
});
