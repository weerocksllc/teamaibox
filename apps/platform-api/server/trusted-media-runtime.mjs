import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { TrustedMediaCastingRuntimeClient } from "../src/casting/trusted-media-runtime-client.mjs";

const CONFIGURATION = Object.freeze([
  "PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN",
  "PLATFORM_TRUSTED_MEDIA_RUNTIME_SERVER_NAME",
  "PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE",
  "PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_CERT_FILE",
  "PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE",
]);

function protectedBytes(environment, protectedInputs, name) {
  const supplied = protectedInputs?.[name];
  if (supplied !== undefined) {
    if (!Buffer.isBuffer(supplied)) throw new TypeError(`Protected trusted-media input ${name} is invalid`);
    return Promise.resolve(Buffer.from(supplied));
  }
  const path = environment[name];
  if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  return readFile(path);
}

export function trustedMediaRuntimeConfigured(environment = process.env) {
  const count = CONFIGURATION.filter((name) => Boolean(environment[name])).length;
  if (count !== 0 && count !== CONFIGURATION.length) {
    throw new TypeError("Trusted media runtime settings must be provided together");
  }
  return count === CONFIGURATION.length;
}

export async function createTrustedMediaRuntimeFromEnvironment(environment = process.env, {
  protectedInputs = null,
  transport,
} = {}) {
  if (!trustedMediaRuntimeConfigured(environment)) throw new TypeError("Trusted media runtime is not configured");
  const values = [];
  try {
    for (const name of CONFIGURATION.slice(2)) {
      const value = await protectedBytes(environment, protectedInputs, name);
      if (value.byteLength < 64 || value.byteLength > 1024 * 1024) {
        value.fill(0);
        throw new TypeError(`${name} is invalid`);
      }
      values.push(value);
    }
    return new TrustedMediaCastingRuntimeClient({
      origin: environment.PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN,
      serverName: environment.PLATFORM_TRUSTED_MEDIA_RUNTIME_SERVER_NAME,
      ca: values[0], cert: values[1], key: values[2],
      ...(transport ? { transport } : {}),
    });
  } finally { values.forEach((value) => value.fill(0)); }
}

