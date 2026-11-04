import assert from "node:assert/strict";
import {createHash} from 'node:crypto';
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const verifier = new URL("../tools/verify-bundle.mjs", import.meta.url);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-web-bundle-"));
  const assets = join(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(join(root, "index.html"), '<div id="root"></div><script src="/theme-prepaint.js"></script><script type="module" src="/assets/index-a.js"></script><link rel="stylesheet" href="/assets/index-a.css">'),
    writeFile(join(root, "theme-prepaint.js"), "document.documentElement.dataset.theme='dark'"),
    writeFile(join(assets, "index-a.js"), 'const product="Team AI Box";import("./panel-b.js");\n//# sourceMappingURL=index-a.js.map\n'),
    writeFile(join(assets, "index-a.js.map"), "{}"),
    writeFile(join(assets, "index-a.css"), "body{color:#fff}"),
    writeFile(join(assets, "panel-b.js"), 'export const panel="ready";\n//# sourceMappingURL=panel-b.js.map\n'),
    writeFile(join(assets, "panel-b.js.map"), "{}"),
  ]);
  return { root, assets };
}

test("bundle verifier covers every reachable split production asset", async () => {
  const value = await fixture();
  try {
    const result = await execute(process.execPath, [verifier.pathname, value.root]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.assets, 3);
    assert.equal(report.entryAssets, 2);
    assert.ok(report.entryScriptBytes > 0 && report.entryScriptBytes < 500_000);
    assert.equal(report.sourceMaps, 2);
    assert.match(report.digest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(value.root, { recursive: true });
  }
});

test('bundle verifier follows bundled math fonts and rejects missing/orphan resources',async()=>{
  const value=await fixture();
  try{
    await writeFile(join(value.assets,'index-a.css'),'@font-face{font-family:Math;src:url(data:font/woff2;base64,AA==)}');
    await assert.rejects(execute(process.execPath,[verifier.pathname,value.root]),e=>/fonts must be local files/.test(e.stderr));
    await writeFile(join(value.assets,'index-a.css'),'@font-face{font-family:Math;src:url(/assets/math-a.woff2)}');
    await assert.rejects(execute(process.execPath,[verifier.pathname,value.root]),e=>/dependency is missing: assets\/math-a.woff2/.test(e.stderr));
    await writeFile(join(value.assets,'math-a.woff2'),'synthetic-font-fixture');
    assert.equal(JSON.parse((await execute(process.execPath,[verifier.pathname,value.root])).stdout).assets,4);
    await writeFile(join(value.assets,'orphan-font.ttf'),'unused');
    await assert.rejects(execute(process.execPath,[verifier.pathname,value.root]),e=>/unreachable production asset: assets\/orphan-font.ttf/.test(e.stderr));
  }finally{await rm(value.root,{recursive:true});}
});

test('compiler runtime receipt never exempts ordinary chunks and binds exact emitted bytes',async()=>{
  const value=await fixture();
  try{
    const code='export const helper=true;';const file='assets/rolldown-runtime-test.js';
    await writeFile(join(value.assets,'panel-b.js'),'import "./rolldown-runtime-test.js";export const panel="ready";');
    await writeFile(join(value.root,file),code);
    const asset={file,kind:'rolldown-runtime',sha256:createHash('sha256').update(code).digest('hex'),modules:['\0rolldown/runtime.js']};
    await writeFile(join(value.root,'generated-runtime.json'),JSON.stringify({version:1,assets:[asset]}));
    assert.equal(JSON.parse((await execute(process.execPath,[verifier.pathname,value.root])).stdout).compilerRuntimeAssets,1);
    await writeFile(join(value.root,file),code+'changed');
    await assert.rejects(execute(process.execPath,[verifier.pathname,value.root]),e=>/Generated runtime digest mismatch/.test(e.stderr));
    await writeFile(join(value.root,'generated-runtime.json'),JSON.stringify({version:1,assets:[{...asset,modules:['/src/product.ts']}]}));
    await assert.rejects(execute(process.execPath,[verifier.pathname,value.root]),e=>/Invalid generated runtime identity/.test(e.stderr));
  }finally{await rm(value.root,{recursive:true});}
});

test("bundle verifier rejects an unreachable emitted chunk", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.assets, "orphan-c.js"), 'export const orphan=true;\n//# sourceMappingURL=orphan-c.js.map\n');
    await writeFile(join(value.assets, "orphan-c.js.map"), "{}");
    await assert.rejects(execute(process.execPath, [verifier.pathname, value.root]), (error) => {
      assert.match(error.stderr, /unreachable production asset: assets\/orphan-c\.js/);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true });
  }
});

test("bundle verifier rejects a split chunk without its source map", async () => {
  const value = await fixture();
  try {
    await rm(join(value.assets, "panel-b.js.map"));
    await assert.rejects(execute(process.execPath, [verifier.pathname, value.root]), (error) => {
      assert.match(error.stderr, /JavaScript source map is missing: assets\/panel-b\.js\.map/);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true });
  }
});
test("bundle verifier follows lazy CSS dependencies but still rejects missing or orphan styles", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.assets, "panel-b.js"), 'const deps=["assets/panel-b.css"];export const panel="ready";');
    await assert.rejects(execute(process.execPath, [verifier.pathname, value.root]), error => /dependency is missing: assets\/panel-b.css/.test(error.stderr));
    await writeFile(join(value.assets, "panel-b.css"), '.panel{color:green}');
    assert.equal(JSON.parse((await execute(process.execPath, [verifier.pathname, value.root])).stdout).assets, 4);
    await writeFile(join(value.assets, "orphan-c.css"), '.orphan{color:red}');
    await assert.rejects(execute(process.execPath, [verifier.pathname, value.root]), error => /unreachable production asset: assets\/orphan-c.css/.test(error.stderr));
  } finally { await rm(value.root, { recursive: true }); }
});
