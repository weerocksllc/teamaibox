import assert from "node:assert/strict";
import test from "node:test";

import { HttpsModelRangeSource } from "../src/models/https-model-range-source.mjs";

function response(status, body, headers) {
  return new Response(body, { status, headers });
}
const code = (expected) => (error) => error?.code === expected;

test("HTTPS range source validates exact Content-Range and sends If-Range", async () => {
  const calls = [];
  const source = new HttpsModelRangeSource({
    fetchImplementation: async (uri, options) => {
      calls.push({ uri: uri.href, options });
      return response(206, Buffer.from("cdef"), {
        "content-length": "4", "content-range": "bytes 2-5/10", etag: '"stable"',
      });
    },
  });
  const result = await source.fetchRange({
    uri: "https://models.example.test/weights.bin", start: 2, end: 5, etag: '"stable"',
  });
  assert.equal(result.bytes.toString(), "cdef");
  assert.equal(result.totalSize, 10);
  assert.equal(calls[0].options.headers.Range, "bytes=2-5");
  assert.equal(calls[0].options.headers["If-Range"], '"stable"');
  assert.equal(calls[0].options.credentials, "omit");
});

test("redirects are fail-closed unless the CDN host is explicitly allowed", async () => {
  const redirect = async () => response(302, null, { location: "https://cdn.example.test/object" });
  await assert.rejects(new HttpsModelRangeSource({ fetchImplementation: redirect }).fetchRange({
    uri: "https://models.example.test/weights.bin", start: 0, end: 3,
  }), code("model_source_redirect_invalid"));

  const allowed = new HttpsModelRangeSource({
    allowedRedirectHosts: ["cdn.example.test"],
    fetchImplementation: async (uri) => uri.host === "models.example.test"
      ? response(302, null, { location: "https://cdn.example.test/object" })
      : response(206, Buffer.from("abcd"), { "content-length": "4", "content-range": "bytes 0-3/4" }),
  });
  assert.equal((await allowed.fetchRange({ uri: "https://models.example.test/weights.bin", start: 0, end: 3 })).bytes.toString(), "abcd");
});

test("range source rejects oversized requests and servers that ignore partial ranges", async () => {
  const source = new HttpsModelRangeSource({
    fetchImplementation: async () => response(200, Buffer.from("abcd"), { "content-length": "4" }),
  });
  await assert.rejects(source.fetchRange({
    uri: "https://models.example.test/weights.bin", start: 1, end: 4,
  }), code("model_source_range_invalid"));
  await assert.rejects(source.fetchRange({
    uri: "https://models.example.test/weights.bin", start: 0, end: 64 * 1024 * 1024,
  }), code("model_source_range_invalid"));
});
