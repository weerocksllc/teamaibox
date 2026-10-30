import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigurationError, loadConfiguration } from "../src/index.mjs";

const schema = {
  serviceName: { type: "string", pattern: /^[a-z][a-z0-9-]+$/ },
  port: { type: "integer", minimum: 1024, maximum: 65535 },
  enabled: { type: "boolean", default: false },
  mode: { type: "enum", values: ["local", "cluster"] },
  endpoint: { type: "url", protocols: ["https:"] },
  credentialRef: { type: "secret-ref", sensitive: true },
};

test("loads, types, validates, and deeply freezes configuration", () => {
  const value = loadConfiguration({
    prefix: "TAI_",
    schema,
    environment: {
      TAI_SERVICE_NAME: "platform-api",
      TAI_PORT: "8080",
      TAI_ENABLED: "1",
      TAI_MODE: "local",
      TAI_ENDPOINT: "https://provider.internal/v1",
      TAI_CREDENTIAL_REF: "provider.primary",
    },
  });
  assert.deepEqual(value, {
    serviceName: "platform-api",
    port: 8080,
    enabled: true,
    mode: "local",
    endpoint: "https://provider.internal/v1",
    credentialRef: "provider.primary",
  });
  assert.equal(Object.isFrozen(value), true);
});

test("fails closed for missing, malformed, and unknown values", () => {
  assert.throws(
    () => loadConfiguration({
      prefix: "TAI_",
      schema,
      environment: {
        TAI_SERVICE_NAME: "Platform API",
        TAI_PORT: "80",
        TAI_MODE: "remote",
        TAI_ENDPOINT: "https://user:password@provider.internal/v1",
        TAI_CREDENTIAL_REF: "actual secret value",
        TAI_UNDECLARED: "present",
      },
    }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.issues.some((issue) => issue.reason === "unknown_key"), true);
      assert.equal(JSON.stringify(error).includes("actual secret value"), false);
      assert.equal(error.issues.find((issue) => issue.key === "TAI_CREDENTIAL_REF").received, "[REDACTED]");
      return true;
    },
  );
});

test("does not support raw secret configuration types", () => {
  assert.throws(
    () => loadConfiguration({
      prefix: "TAI_",
      schema: { secretValue: { type: "secret" } },
      environment: { TAI_SECRET_VALUE: "do-not-load" },
    }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.issues[0].message, "invalid sensitive value");
      assert.equal(JSON.stringify(error).includes("do-not-load"), false);
      return true;
    },
  );
});
