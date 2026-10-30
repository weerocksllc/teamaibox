import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTrustedMediaRuntimeFromEnvironment,
  trustedMediaRuntimeConfigured,
} from "../server/trusted-media-runtime.mjs";

const ENVIRONMENT = Object.freeze({
  PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN: "https://10.64.0.20:17443",
  PLATFORM_TRUSTED_MEDIA_RUNTIME_SERVER_NAME: "trusted-media.teamaibox.internal",
  PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE: "/run/secrets/trusted-media-ca",
  PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_CERT_FILE: "/run/secrets/platform-media-client-cert",
  PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE: "/run/secrets/platform-media-client-key",
});
const CERT = Buffer.from(`${"-".repeat(32)}\n-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n`);
const KEY = Buffer.from(`${"-".repeat(32)}\n-----BEGIN ${"PRIVATE KEY"}-----\n${"B".repeat(96)}\n`);

test("trusted media runtime configuration is atomic and absent by default", () => {
  assert.equal(trustedMediaRuntimeConfigured({}), false);
  assert.equal(trustedMediaRuntimeConfigured(ENVIRONMENT), true);
  assert.throws(() => trustedMediaRuntimeConfigured({
    PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN: ENVIRONMENT.PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN,
  }), /must be provided together/);
});

test("trusted media runtime reads the three protected inputs without retaining caller buffers", async () => {
  const inputs = {
    PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE: Buffer.from(CERT),
    PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_CERT_FILE: Buffer.from(CERT),
    PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE: Buffer.from(KEY),
  };
  const client = await createTrustedMediaRuntimeFromEnvironment(ENVIRONMENT, {
    protectedInputs: inputs,
    transport: { request: async () => ({ status: 200,
      body: { healthy: true, outputs: { hdmi: { healthy: true }, browser: { healthy: true } } } }) },
  });
  assert.equal((await client.health({ sessionId: "10000000-0000-4000-8000-000000000001" })).healthy, true);
  assert.ok(inputs.PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE.equals(CERT));
  assert.ok(inputs.PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE.equals(KEY));
  client.close();
});
