import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OfflineMediaHttpApi } from "../src/sources/offline-media-http-api.mjs";

test("offline media HTTP API exposes discovery, approval, inventory, and artifacts only on administrator routes", async () => {
  const calls = [];
  const service = new Proxy({}, { get(_target, method) { return async (input) => { calls.push([method, input]); return method === "get" || method === "approve" ? { mediaId: input.mediaId } : { object: "list", data: [] }; }; } });
  const api = new OfflineMediaHttpApi({ service });
  const context = { identityId: randomUUID(), permissions: ["source:view", "source:manage"] };
  const nodeId = randomUUID(), mediaId = randomUUID();
  assert.equal(api.matches("POST", "/api/v1/admin/source-center/offline-media/discover"), true);
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/source-center/offline-media/discover", body: { nodeId }, context })).status, 200);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/source-center/offline-media", query: new URLSearchParams(`nodeId=${nodeId}`), context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/source-center/offline-media/${mediaId}/approve`, body: { expectedRevision: 2, expectedManifestSha256: `sha256:${"a".repeat(64)}` }, context })).status, 200);
  assert.equal((await api.handle({ method: "GET", pathname: `/api/v1/admin/source-center/offline-media/${mediaId}/artifacts`, context })).status, 200);
  assert.deepEqual(calls.map(([method]) => method), ["discover", "list", "approve", "artifacts"]);
  assert.equal(calls[0][1].nodeId, nodeId);
  assert.equal(calls[2][1].expectedRevision, 2);
});
