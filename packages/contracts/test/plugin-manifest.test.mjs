import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractRoot = new URL("../", import.meta.url);

async function load(relative) {
  return JSON.parse(await readFile(new URL(relative, contractRoot), "utf8"));
}

test("publishes one strict signed manifest for exactly ApplicationPlugin or ComputePlugin", async () => {
  const catalog = await load("catalog.v1.json");
  const catalogEntry = catalog.contracts.find((entry) => entry.id === "plugin-manifest");
  assert.deepEqual(catalogEntry, {
    id: "plugin-manifest",
    family: "plugin",
    major: 1,
    role: "request",
    stability: "stable",
    path: "plugins/manifest.v1.schema.json",
  });
  const schema = await load(catalogEntry.path);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.type.enum, ["ApplicationPlugin", "ComputePlugin"]);
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.oneOf[0].properties.entryPoints.properties.worker, false);
  assert.equal(schema.oneOf[1].properties.entryPoints.properties.web, false);
});

test("manifest requires pinned ARM64 OCI variants and a canonical Ed25519 signature declaration", async () => {
  const schema = await load("plugins/manifest.v1.schema.json");
  assert.deepEqual(schema.properties.architectures.items.enum, ["linux/arm64/v8"]);
  const variants = schema.properties.images.items.properties.variants.items;
  assert.deepEqual(variants.required, ["architecture", "reference", "digest", "mediaType"]);
  assert.deepEqual(variants.properties.architecture.enum, ["linux/arm64/v8"]);
  assert.equal(variants.properties.digest.$ref, "#/$defs/sha256");
  assert.equal(schema.properties.signature.properties.algorithm.const, "Ed25519");
  assert.equal(schema.properties.signature.properties.format.const, "teamaibox.canonical-json/v1");
  assert.ok(schema.required.includes("signature"));
});

test("manifest covers APIs, UI, locale direction, themes, permissions, resources, health, migrations, and compatibility", async () => {
  const schema = await load("plugins/manifest.v1.schema.json");
  const required = new Set(schema.required);
  for (const field of [
    "apis", "ui", "localization", "themes", "permissions", "resources",
    "health", "migrations", "compatibility",
  ]) assert.ok(required.has(field), field);
  assert.deepEqual(schema.properties.localization.required, [
    "supportedLocales", "fallbackLocale", "supportedDirections", "rtlReady",
  ]);
  assert.deepEqual(schema.properties.themes.properties.supported.items.enum, ["light", "dark"]);
  assert.deepEqual(schema.properties.health.required, ["startup", "readiness", "liveness"]);
  const serialized = JSON.stringify(schema).toLowerCase();
  assert.equal(serialized.includes("dedicatedvram"), false);
  assert.equal(serialized.includes("dockersocket"), false);
  assert.equal(serialized.includes("hostmount"), false);
});
