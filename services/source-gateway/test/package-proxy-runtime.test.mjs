import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

import { createPackageProxyServer } from "../src/package-proxy-runtime.mjs";

test("compressed upstream metadata uses decoded length and remains valid on cache hits", async () => {
  const root=await mkdtemp(join(tmpdir(),"teamaibox-package-gzip-"));
  const data=JSON.stringify({name:'fixture',versions:{}}),compressed=gzipSync(data);
  const upstream=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':compressed.length});response.end(compressed)});
  const upstreamOrigin=await listen(upstream);
  const proxy=createPackageProxyServer({cacheRoot:root,fetchImplementation:(_url,options)=>fetch(upstreamOrigin,options)});
  const origin=await listen(proxy);
  try{
    for(const expected of ['upstream','cache']){
      const response=await fetch(origin+'/npm/registry/fixture');assert.equal(response.status,200);
      assert.equal(response.headers.get('x-teamaibox-source'),expected);assert.deepEqual(await response.json(),JSON.parse(data));
    }
  }finally{await stop(proxy);await stop(upstream);await rm(root,{recursive:true,force:true})}
});

test("streams packages beyond 128 MiB and serves their verified cache without whole-package buffering", async () => {
  const root=await mkdtemp(join(tmpdir(),"teamaibox-package-stream-")),chunk=Buffer.alloc(1024*1024,0x5a),count=132;
  const expected=createHash('sha256');for(let i=0;i<count;i++)expected.update(chunk);
  const digest=expected.digest('hex');let calls=0;
  const server=createPackageProxyServer({cacheRoot:root,fetchImplementation:async()=>{calls++;let sent=0;return new Response(new ReadableStream({pull(controller){if(sent++<count)controller.enqueue(chunk);else controller.close()}}),{headers:{'content-length':String(chunk.length*count)}})}});
  const origin=await listen(server);
  try{
    const target=Buffer.from('https://registry.npmjs.org/fixture/-/fixture.tgz').toString('base64url');
    for(const source of ['upstream','cache']){
      const response=await fetch(origin+'/npm/tarballs/'+target);assert.equal(response.status,200);assert.equal(response.headers.get('x-teamaibox-source'),source);
      const hash=createHash('sha256');let size=0;for await(const part of response.body){size+=part.length;hash.update(part)}
      assert.equal(size,132*1024*1024);assert.equal(hash.digest('hex'),digest);
    }
    assert.equal(calls,1);
  }finally{await stop(server);await rm(root,{recursive:true,force:true})}
});

test("healthy download progress is not cut off by a total-duration timeout", async () => {
  const root=await mkdtemp(join(tmpdir(),"teamaibox-package-progress-"));let sent=0;
  const server=createPackageProxyServer({cacheRoot:root,upstreamAttemptTimeoutMilliseconds:100,upstreamRetryDelaysMilliseconds:[],
    fetchImplementation:async()=>new Response(new ReadableStream({async pull(controller){await new Promise(resolve=>setTimeout(resolve,20));if(sent++<12)controller.enqueue(Buffer.from('abc'));else controller.close()}}))});
  const origin=await listen(server);
  try{const response=await fetch(origin+'/apt/dists/bookworm/InRelease');assert.equal(response.status,200);assert.equal((await response.text()).length,36)}
  finally{await stop(server);await rm(root,{recursive:true,force:true})}
});

test("actual exhausted cache storage refuses transfer and removes only its partial download", async () => {
  const root=await mkdtemp(join(tmpdir(),"teamaibox-package-no-space-"));let canceled=false;
  const server=createPackageProxyServer({cacheRoot:root,availableDisk:async()=>4,upstreamRetryDelaysMilliseconds:[],
    fetchImplementation:async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(Buffer.from('12345678'))},cancel(){canceled=true}}),{headers:{'content-length':'8'}})});
  const origin=await listen(server);
  try{const response=await fetch(origin+'/apt/dists/bookworm/InRelease');assert.equal(response.status,507);assert.equal((await response.json()).error.code,'package_cache_storage_unavailable');assert.equal(canceled,true);assert.deepEqual(await readdir(join(root,'apt')),[])}
  finally{await stop(server);await rm(root,{recursive:true,force:true})}
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("native package proxy rewrites external artifacts and serves verified cache without an upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-"));
  const calls = [];
  const fixtures = new Map([
    ["https://pypi.org/simple/demo-package/", new Response('<a href="https://files.pythonhosted.org/packages/demo.whl#sha256=abc">demo.whl</a>', { headers: { "content-type": "text/html" } })],
    ["https://files.pythonhosted.org/packages/demo.whl", new Response("wheel-bytes", { headers: { "content-type": "application/octet-stream" } })],
    ["https://registry.npmjs.org/is-number", new Response(JSON.stringify({ versions: { "7.0.0": { dist: { tarball: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", integrity: "sha512-test" } } } }), { headers: { "content-type": "application/json" } })],
    ["https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", new Response("npm-bytes", { headers: { "content-type": "application/octet-stream" } })],
    ["https://repo.huaweicloud.com/debian/dists/bookworm/InRelease", new Response("signed-release", { headers: { "content-type": "text/plain" } })],
  ]);
  const fetchImplementation = async (url) => {
    const target = String(url);
    calls.push(target);
    const fixture = fixtures.get(target);
    assert.ok(fixture, `unexpected upstream ${target}`);
    return fixture.clone();
  };
  const server = createPackageProxyServer({ cacheRoot: root, fetchImplementation });
  const origin = await listen(server);
  try {
    const pip = await fetch(`${origin}/pip/simple/demo-package/`);
    assert.equal(pip.status, 200);
    assert.equal(pip.headers.get("x-teamaibox-source"), "upstream");
    const pipHtml = await pip.text();
    assert.doesNotMatch(pipHtml, /files\.pythonhosted\.org/);
    const pipFilePath = /href="([^#"]+)/.exec(pipHtml)[1];
    assert.match(pipFilePath, /\/demo\.whl$/);
    assert.equal(await (await fetch(origin + pipFilePath)).text(), "wheel-bytes");

    const npm = await fetch(`${origin}/npm/registry/is-number`);
    assert.equal(npm.status, 200);
    const npmValue = await npm.json();
    const tarball = new URL(npmValue.versions["7.0.0"].dist.tarball);
    assert.equal(tarball.hostname, "source-gateway");
    assert.equal(await (await fetch(origin + tarball.pathname)).text(), "npm-bytes");

    const apt = await fetch(`${origin}/apt/dists/bookworm/InRelease`);
    assert.equal(await apt.text(), "signed-release");
    assert.equal(apt.headers.get("connection"), "close");
    assert.equal(calls.length, 5);
  } finally {
    await stop(server);
  }

  const offline = createPackageProxyServer({
    cacheRoot: root,
    fetchImplementation: async () => { throw new Error("network_must_not_be_used"); },
  });
  const offlineOrigin = await listen(offline);
  try {
    const requests = [
      "/pip/simple/demo-package/",
      "/apt/dists/bookworm/InRelease",
    ];
    for (const path of requests) {
      const response = await fetch(offlineOrigin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-teamaibox-source"), "cache");
    }
    const health = await (await fetch(`${offlineOrigin}/health/ready`)).json();
    assert.equal(health.stats.pip.cacheHits, 1);
    assert.equal(health.stats.apt.cacheHits, 1);
  } finally {
    await stop(offline);
    await rm(root, { recursive: true, force: true });
  }
});

test("package proxy rejects direct, traversal, credentialed, and unsupported targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-denial-"));
  const server = createPackageProxyServer({ cacheRoot: root, fetchImplementation: async () => { throw new Error("unexpected_fetch"); } });
  const origin = await listen(server);
  try {
    for (const path of [
      "/pip/simple/../secret/",
      "/npm/registry/../../secret",
      "/apt/../etc/passwd",
      `/pip/files/${Buffer.from("https://user:pass@files.pythonhosted.org/a").toString("base64url")}`,
    ]) {
      const response = await fetch(origin + path);
      assert.ok(response.status >= 400);
    }
    assert.equal((await fetch(`${origin}/pip/simple/example/`, { method: "POST" })).status, 405);
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("package proxy accepts a canonical PyPI artifact whose URL object adds the default slash semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-pypi-"));
  const artifact = "https://files.pythonhosted.org/packages/b7/ce/six-1.17.0-py2.py3-none-any.whl";
  const server = createPackageProxyServer({
    cacheRoot: root,
    fetchImplementation: async (url) => {
      assert.equal(String(url), artifact);
      return new Response("wheel");
    },
  });
  const origin = await listen(server);
  try {
    const encoded = Buffer.from(artifact).toString("base64url");
    const response = await fetch(`${origin}/pip/files/${encoded}/six-1.17.0-py2.py3-none-any.whl`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "wheel");
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("package proxy serves PEP 658 metadata only beside its exact bound wheel", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-pep658-"));
  const artifact = "https://files.pythonhosted.org/packages/b7/ce/six-1.17.0-py2.py3-none-any.whl";
  const server = createPackageProxyServer({
    cacheRoot: root,
    fetchImplementation: async (url) => {
      assert.equal(String(url), `${artifact}.metadata`);
      return new Response("Metadata-Version: 2.1\nName: six\nVersion: 1.17.0\n");
    },
  });
  const origin = await listen(server);
  try {
    const encoded = Buffer.from(artifact).toString("base64url");
    const response = await fetch(`${origin}/pip/files/${encoded}/six-1.17.0-py2.py3-none-any.whl.metadata`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Version: 1\.17\.0/);
    assert.ok((await fetch(`${origin}/pip/files/${encoded}/different.whl.metadata`)).status >= 400);
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("package proxy bounds and retries an idempotent upstream GET after a half-open connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-retry-"));
  let attempts = 0;
  const server = createPackageProxyServer({
    cacheRoot: root,
    upstreamAttemptTimeoutMilliseconds: 10,
    upstreamRetryDelaysMilliseconds: [0],
    fetchImplementation: async (_url, options) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      return new Response("signed-release", { headers: { "content-type": "text/plain" } });
    },
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/apt/dists/bookworm/InRelease`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "signed-release");
    assert.equal(response.headers.get("x-teamaibox-source"), "upstream");
    assert.equal(attempts, 2);
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("package proxy does not retry a definitive upstream 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-package-proxy-no-retry-"));
  let attempts = 0;
  const server = createPackageProxyServer({
    cacheRoot: root,
    upstreamAttemptTimeoutMilliseconds: 100,
    upstreamRetryDelaysMilliseconds: [0, 0],
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("missing", { status: 404 });
    },
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/apt/dists/bookworm/InRelease`);
    assert.equal(response.status, 404);
    assert.equal(attempts, 1);
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});
