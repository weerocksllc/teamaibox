import assert from "node:assert/strict";
import { setImmediate as delay } from "node:timers/promises";
import { test } from "node:test";

import {
  PlatformError,
  createStructuredLogger,
  currentCorrelationId,
  errorResponse,
  normalizeCorrelationId,
  redact,
  runWithCorrelation,
} from "../src/index.mjs";

test("validates and propagates correlation IDs through asynchronous work", async () => {
  assert.equal(normalizeCorrelationId("request-12345678"), "request-12345678");
  assert.match(normalizeCorrelationId("bad"), /^[0-9a-f-]{36}$/);
  await runWithCorrelation("request-12345678", async () => {
    await delay();
    assert.equal(currentCorrelationId(), "request-12345678");
  });
  assert.equal(currentCorrelationId(), null);
});

test("serializes platform errors and hides unknown exceptions", () => {
  const safe = errorResponse(new PlatformError("invalid_request", "Request is invalid", {
    status: 400,
    details: { field: "model", authorization: "Bearer secret" },
  }), "request-abcdefgh");
  assert.equal(safe.status, 400);
  assert.equal(safe.body.error.details.authorization, "[REDACTED]");

  const unknown = errorResponse(new Error("database password leaked"), "request-abcdefgh");
  assert.equal(unknown.status, 500);
  assert.equal(JSON.stringify(unknown).includes("database password leaked"), false);
});

test("recursively redacts sensitive keys and byte material", () => {
  const result = redact({
    nested: { apiToken: "secret", ordinary: "visible" },
    payload: Buffer.from("bytes"),
    list: [{ password: "hidden" }],
  });
  assert.equal(result.nested.apiToken, "[REDACTED]");
  assert.equal(result.nested.ordinary, "visible");
  assert.equal(result.payload, "[REDACTED_BYTES]");
  assert.equal(result.list[0].password, "[REDACTED]");
});

test("redacts secret-shaped values even when a producer uses an ordinary field name", () => {
  const result = redact({
    message: "request Authorization: Bearer abc.def-123456 password=hunter2",
    endpoint: "https://build-user:build-pass@packages.example.test/simple",
    jwt: "eyJabcdefghij.abcdefghijk.abcdefghijkl",
    material: `-----BEGIN ${"PRIVATE"} KEY-----\nnot-real\n-----END ${"PRIVATE"} KEY-----`,
  });
  assert.equal(JSON.stringify(result).includes("abc.def-123456"), false);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes("build-pass"), false);
  assert.equal(JSON.stringify(result).includes("eyJabcdefghij"), false);
  assert.equal(result.material, "[REDACTED]");
});

test("writes correlated redacted JSON lines", async () => {
  let output = "";
  const logger = createStructuredLogger({
    service: "platform-api",
    destination: { write: (value) => { output += value; } },
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  await runWithCorrelation("request-12345678", async () => {
    logger.info("request.accepted", {
      credential: "hidden",
      route: "local",
      service: "spoofed-service",
      correlationId: "spoofed-correlation",
    });
  });
  const record = JSON.parse(output);
  assert.equal(record.correlationId, "request-12345678");
  assert.equal(record.service, "platform-api");
  assert.equal(record.credential, "[REDACTED]");
  assert.equal(record.route, "local");
});
