import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identityKeys = ["phoneId", "ownerId", "volumeId", "poolId", "baseBuildId"];
const booleanKeys = ["storageReady", "androidReady", "mediaReady", "runtimeStopped", "cleanShutdown", "dataDeleted"];
export const PHONE_COMMAND_TIMEOUT = Object.freeze({ provision: 120_000, start: 600_000, inspect: 10_000, stop: 120_000, delete: 120_000 });
const closed = (value, required, optional = []) => value && typeof value === "object" && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));

export function validateAndroidPhoneCommand(action, payload) {
  if (!Object.hasOwn(PHONE_COMMAND_TIMEOUT, action)
      || !closed(payload, [...identityKeys, "operationId", "generation"], ["run"])
      || ["phoneId", "ownerId", "volumeId", "operationId"].some(key => !UUID.test(payload[key] ?? ""))
      || !/^[a-z][a-z0-9_.-]{2,127}$/.test(payload.poolId ?? "") || payload.baseBuildId !== "16102939"
      || !Number.isSafeInteger(payload.generation) || payload.generation < 0 || payload.generation >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Invalid android-phone command identity");
  }
  if (["start", "stop", "inspect"].includes(action)) {
    const run = payload.run;
    if (payload.generation === 0 || !closed(run, ["id", "reservationId", "imageDigest", "memoryBytes", "cpuMillis"])
        || !UUID.test(run.id ?? "") || !UUID.test(run.reservationId ?? "") || !/^sha256:[a-f0-9]{64}$/.test(run.imageDigest ?? "")
        || run.memoryBytes !== 6 * 1024 ** 3 || run.cpuMillis !== 2000) throw new TypeError("Invalid android-phone runtime configuration");
  } else if (Object.hasOwn(payload, "run") || action === "provision" && payload.generation !== 0) {
    throw new TypeError("Invalid android-phone storage command");
  }
  return Object.freeze(structuredClone(payload));
}

export function validateAndroidPhoneResult(action, payload, value) {
  const invalid = () => { throw new PlatformError("node_agent_protocol_mismatch", "本机返回的手机状态与当前运行不符。", { status: 502 }); };
  if (!closed(value, [...identityKeys, "operationId", "generation", ...booleanKeys], ["runId", "containerId", "protectionReason"])
      || [...identityKeys, "operationId", "generation"].some(key => value[key] !== payload[key])
      || booleanKeys.some(key => typeof value[key] !== "boolean") || value.runId !== payload.run?.id
      || (value.containerId !== undefined && !/^[a-f0-9]{64}$/.test(value.containerId))
      || value.runtimeStopped && (value.androidReady || value.mediaReady) || value.cleanShutdown && !value.runtimeStopped
      || value.protectionReason !== undefined && !["memory_margin", "memory_pressure", "swap_out"].includes(value.protectionReason)) invalid();
  const valid = action === "provision" ? value.storageReady && value.runtimeStopped && !value.dataDeleted && !value.containerId
    : action === "start" ? value.storageReady && value.androidReady && value.mediaReady && value.containerId && !value.dataDeleted
    : action === "inspect" ? !value.dataDeleted && (value.runtimeStopped || value.containerId)
    : action === "stop" ? value.runtimeStopped && !value.dataDeleted
    : action === "delete" && value.runtimeStopped && value.dataDeleted && !value.storageReady && !value.containerId;
  if (!valid) invalid();
  return Object.freeze(structuredClone(value));
}
