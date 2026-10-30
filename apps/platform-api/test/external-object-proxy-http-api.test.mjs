import assert from "node:assert/strict";
import test from "node:test";

import { ExternalObjectProxyHttpApi, matchesExternalObjectProxyRoute } from "../src/providers/external-object-proxy-http-api.mjs";

const TOKEN = "a".repeat(43);
const PATH = `/api/v1/external-object-proxy/${TOKEN}/content`;

test("external object proxy exposes only exact opaque content routes", () => {
  assert.equal(matchesExternalObjectProxyRoute("GET", PATH), true);
  assert.equal(matchesExternalObjectProxyRoute("HEAD", PATH), true);
  assert.equal(matchesExternalObjectProxyRoute("PUT", PATH), true);
  assert.equal(matchesExternalObjectProxyRoute("GET", "/api/v1/external-object-proxy"), false);
  assert.equal(matchesExternalObjectProxyRoute("GET", "/api/v1/external-object-proxy/objects"), false);
  assert.equal(matchesExternalObjectProxyRoute("DELETE", PATH), false);
});

test("proxy maps HEAD, ranged GET, and one-time output without leaking object identity", async () => {
  const calls = [];
  const api = new ExternalObjectProxyHttpApi({ service: {
    async head(input) { calls.push(["head", input]); return { size: 9, contentType: "text/plain", integrity: { digest: "b".repeat(64) } }; },
    async download(input) { calls.push(["download", input]); return { metadata: { contentType: "text/plain", integrity: { digest: "b".repeat(64) } }, content: Buffer.from("part"), partial: true, range: { start: 1, endInclusive: 4, total: 9 } }; },
    async upload(input) { calls.push(["upload", input]); return { objectId: "hidden", version: 1, size: 4, integrity: { digest: "c".repeat(64) } }; },
  } });
  const head = await api.handle({ method: "HEAD", pathname: PATH });
  assert.equal(head.headers["content-length"], "9");
  const get = await api.handle({ method: "GET", pathname: PATH, headers: { range: "bytes=1-4" } });
  assert.equal(get.status, 206);
  assert.equal(get.headers["content-range"], "bytes 1-4/9");
  const put = await api.handle({ method: "PUT", pathname: PATH, body: Buffer.from("part"), headers: { "content-type": "text/plain", "x-content-sha256": `sha256:${"c".repeat(64)}` } });
  assert.deepEqual(put.body, { stored: true, size: 4, integrity: { algorithm: "sha256", digest: `sha256:${"c".repeat(64)}` } });
  assert.equal(JSON.stringify(put).includes("hidden"), false);
  assert.deepEqual(calls[1][1].range, { start: 1, endInclusive: 4 });
});
