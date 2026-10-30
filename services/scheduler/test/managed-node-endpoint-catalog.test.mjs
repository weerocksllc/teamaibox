import assert from "node:assert/strict";
import test from "node:test";

import { ManagedNodeEndpointCatalog } from "../src/managed-node-endpoint-catalog.mjs";

test("managed-node endpoints bind a certificate name to one bounded LAN address", () => {
  const catalog = new ManagedNodeEndpointCatalog({ document: { schemaVersion: 1, endpoints: [
    { nodeKey: "spark-18.local", host: "10.64.0.18", port: 19463 },
  ] } });
  assert.deepEqual(catalog.resolve("spark-18.local"), { host: "10.64.0.18", port: 19463 });
  assert.equal(catalog.resolve("spark-19.local"), null);
});

test("managed-node endpoints reject duplicates, broad ports, and unknown fields", () => {
  assert.throws(() => new ManagedNodeEndpointCatalog({ document: { schemaVersion: 1, endpoints: [
    { nodeKey: "spark-18.local", host: "10.64.0.18", port: 19463 },
    { nodeKey: "spark-18.local", host: "10.64.0.19", port: 19464 },
  ] } }), /entry is invalid/);
  assert.throws(() => new ManagedNodeEndpointCatalog({ document: { schemaVersion: 1, endpoints: [
    { nodeKey: "spark-18.local", host: "0.0.0.0", port: 443, secret: "forbidden" },
  ] } }), /entry is invalid/);
});
