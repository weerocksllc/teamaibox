import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AuthenticatedCastingMediaAdmission } from "../src/casting/authenticated-media-admission.mjs";
import { AuthenticatedCastingSignallingGateway, NodeMtlsCastingSignallingUpstream }
  from "../src/casting/authenticated-signalling-gateway.mjs";

const SETTINGS = Object.freeze([
  "PLATFORM_CASTING_SIGNALLING_ORIGIN", "PLATFORM_CASTING_SIGNALLING_SERVER_NAME",
  "PLATFORM_CASTING_SIGNALLING_CA_FILE", "PLATFORM_CASTING_SIGNALLING_CERT_FILE",
  "PLATFORM_CASTING_SIGNALLING_KEY_FILE",
]);

export function castingMediaSignallingConfigured(environment = process.env) {
  const count = SETTINGS.filter(name => Boolean(environment[name])).length;
  if (count !== 0 && count !== SETTINGS.length) throw new TypeError("Casting signalling settings must be provided together");
  return count === SETTINGS.length;
}

// The caller supplies Platform's real cookie authentication and secure proxy
// transport check. No identity is accepted from a query, token or request body.
export function createCastingMediaBoundary({ service, runtime, upstream, publicOrigin,
  authenticateRequest, assertSecureRequest }) {
  const admission = new AuthenticatedCastingMediaAdmission({ service, runtime, publicOrigin, authenticateRequest });
  try {
    const gateway = new AuthenticatedCastingSignallingGateway({ admission, upstream, publicOrigin, assertSecureRequest });
    return Object.freeze({ admission, gateway, close: () => gateway.close() });
  } catch (error) {
    void admission.close();
    throw error;
  }
}

export async function createCastingMediaBoundaryFromEnvironment(environment, dependencies) {
  if (!castingMediaSignallingConfigured(environment)) throw new TypeError("Casting signalling is not configured");
  const buffers = [];
  let upstream;
  try {
    for (const name of SETTINGS.slice(2)) {
      if (!isAbsolute(environment[name])) throw new TypeError("Casting signalling certificate path must be absolute");
      const buffer = await readFile(environment[name]);
      buffers.push(buffer);
      if (buffer.length < 64 || buffer.length > 1024 * 1024) throw new TypeError("Casting signalling certificate size is invalid");
    }
    upstream = new NodeMtlsCastingSignallingUpstream({ origin: environment.PLATFORM_CASTING_SIGNALLING_ORIGIN,
      serverName: environment.PLATFORM_CASTING_SIGNALLING_SERVER_NAME, ca: buffers[0], cert: buffers[1], key: buffers[2] });
    return createCastingMediaBoundary({ ...dependencies, upstream });
  } catch (error) {
    upstream?.close();
    throw error;
  } finally { buffers.forEach(value => value.fill(0)); }
}
