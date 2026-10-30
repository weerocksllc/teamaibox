import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilePluginSourceCatalog } from "../src/file-plugin-source-catalog.mjs";

test('catalog packages may contain more than 4096 artifacts and an artifact above 32 MiB',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'teamaibox-catalog-capacity-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const content=Buffer.alloc(33*1024*1024,97),path=join(directory,'catalog.json');
  const artifacts=Array.from({length:4097},(_,i)=>({descriptor:{name:`artifact-${i}`},contentBase64:i===0?content.toString('base64'):'YQ=='}));
  await writeFile(path,JSON.stringify({schemaVersion:1,trust:[],packages:[{sourceKind:'offline-bundle',locator:'large-package',
    bundle:{packageVersion:'teamaibox.plugin-package/v1',manifest:{},artifacts,bundleSignature:{}}}]}));
  const memory={available:()=>2*1024**3,heap:()=>2*1024**3};
  const bundle=await new FilePluginSourceCatalog({path,memory}).resolve({sourceKind:'offline-bundle',locator:'large-package'});
  assert.equal(bundle.artifacts.length,4097);
  const bytes=await bundle.openArtifact('artifact-0');assert.ok(bytes.equals(content));bytes.fill(0);
  assert.equal((await bundle.openArtifact('artifact-4096')).toString(),'a');await bundle.close();
  await assert.rejects(new FilePluginSourceCatalog({path,memory:{available:()=>1024,heap:()=>1024}})
    .resolve({sourceKind:'offline-bundle',locator:'large-package'}),{code:'media_memory_unavailable'});
});

test('an atomic external catalog update is visible without rebuilding or restarting the API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teamaibox-catalog-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.json');
  const trust = { keyId: 'official/stable', publisherId: 'official', status: 'active',
    pluginIds: ['official.virtual-phones'], publicKeyPem: '-----BEGIN PUBLIC KEY-----\npublic-only\n-----END PUBLIC KEY-----\n' };
  await writeFile(path, JSON.stringify({ schemaVersion: 1, trust: [], packages: [] }));
  const catalog = new FilePluginSourceCatalog({ path });
  assert.equal(await catalog.resolveTrust(trust.keyId), null);
  await writeFile(path + '.next', JSON.stringify({ schemaVersion: 1, trust: [trust], packages: [] }));
  await rename(path + '.next', path);
  assert.equal((await catalog.resolveTrust(trust.keyId)).publisherId, 'official');
  await writeFile(path + '.next', JSON.stringify({ schemaVersion: 1, trust: [], packages: [] }));
  await rename(path + '.next', path);
  assert.equal(await catalog.resolveTrust(trust.keyId), null);
});

test("file plugin source selects an exact source locator and exposes artifact bytes separately from descriptors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-plugin-catalog-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.json"), content = Buffer.from("signed artifact", "utf8");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, trust: [{ keyId: "example/release", publisherId: "example", status: "active",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n" }],
  packages: [{ sourceKind: "marketplace", locator: "example.notes@1.0.0", bundle: { packageVersion: "teamaibox.plugin-package/v1", manifest: { id: "example.notes" },
    artifacts: [{ descriptor: { name: "image-index", kind: "oci-image-manifest" }, contentBase64: content.toString("base64") }], bundleSignature: { keyId: "example/release" } } }] }));
  const catalog = new FilePluginSourceCatalog({ path });
  const bundle = await catalog.resolve({ sourceKind: "marketplace", locator: "example.notes@1.0.0" });
  assert.deepEqual(bundle.artifacts, [{ name: "image-index", kind: "oci-image-manifest" }]);
  assert.deepEqual(await bundle.openArtifact("image-index"), content);
  assert.equal(Object.hasOwn(bundle.artifacts[0], "contentBase64"), false);
  const trust = await catalog.resolveTrust("example/release");
  assert.equal(trust.publisherId, "example"); assert.equal(trust.status, "active");
  await assert.rejects(catalog.resolve({ sourceKind: "marketplace", locator: "example.notes@2.0.0" }), (error) => error.code === "plugin_source_not_found");
});

test("file plugin source rejects relative catalogs and non-canonical artifact base64", async (t) => {
  assert.throws(() => new FilePluginSourceCatalog({ path: "catalog.json" }), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-plugin-catalog-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, trust: [], packages: [{ sourceKind: "offline-bundle", locator: "bundle-0001", bundle: {
    packageVersion: "teamaibox.plugin-package/v1", manifest: {}, bundleSignature: {}, artifacts: [{ descriptor: { name: "artifact" }, contentBase64: "YWJj\n" }],
  } }] }));
  const bundle = await new FilePluginSourceCatalog({ path }).resolve({ sourceKind: "offline-bundle", locator: "bundle-0001" });
  await assert.rejects(bundle.openArtifact("artifact"), /invalid/);
});
