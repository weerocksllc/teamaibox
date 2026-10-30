import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { SessionCastingRuntime } from "../src/casting/session-casting-runtime.mjs";

export function normalizeCastingRuntimeIdentity(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'nodeGeneration,nodeId,schemaVersion'
    || value.schemaVersion !== 1 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.nodeId ?? '')
    || !Number.isSafeInteger(value.nodeGeneration) || value.nodeGeneration < 1) {
    throw new TypeError('Casting runtime identity is invalid');
  }
  return {nodeId:value.nodeId,nodeGeneration:value.nodeGeneration};
}

export async function readCastingRuntimeIdentity(path) {
  if (!isAbsolute(path ?? '') || path === '/' || await realpath(path) !== path) {
    throw new TypeError('Casting identity requires a regular configuration file');
  }
  const handle = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 4096) throw new TypeError('Casting identity file is invalid');
    const bytes = Buffer.alloc(before.size+1);
    try {
      const {bytesRead} = await handle.read(bytes,0,bytes.length,0);
      const after = await handle.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new TypeError('Casting identity changed while reading');
      }
      return normalizeCastingRuntimeIdentity(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')));
    } finally {bytes.fill(0);}
  } finally {await handle.close();}
}

export async function createCastingSessionRuntime(environment,{runtime,configuration=null}={}) {
  const nodeIdentity = configuration ? normalizeCastingRuntimeIdentity(configuration)
    : await readCastingRuntimeIdentity(environment.PLATFORM_CASTING_RUNTIME_IDENTITY_FILE);
  if (nodeIdentity.nodeId !== environment.PLATFORM_APPLIANCE_NODE_ID) {
    throw new TypeError('Casting runtime belongs to another appliance');
  }
  return new SessionCastingRuntime({runtime,nodeIdentity});
}
