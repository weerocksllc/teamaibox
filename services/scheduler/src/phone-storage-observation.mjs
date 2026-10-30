import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = new Set(["nodeId", "nodeGeneration", "poolId", "luksUUID", "filesystemUUID", "totalBytes", "availableBytes", "quotaBytes", "reserveBytes", "observedAt"]);

export function phoneStorageObservation(value, { nodeId, nodeGeneration, poolId, now = new Date() }) {
  const at = +new Date(value?.observedAt), current = +new Date(now);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.has(key))
      || value.nodeId !== nodeId || value.nodeGeneration !== nodeGeneration || !UUID.test(nodeId ?? "")
      || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1
      || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.poolId ?? "") || (poolId !== undefined && value.poolId !== poolId)
      || !UUID.test(value.luksUUID ?? "") || !UUID.test(value.filesystemUUID ?? "")
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0
      || !Number.isSafeInteger(value.availableBytes) || value.availableBytes < 0 || value.availableBytes > value.totalBytes
      || value.quotaBytes !== 16 * 2 ** 30 || value.reserveBytes !== 0
      || typeof value.observedAt !== "string" || !Number.isFinite(at) || !Number.isFinite(current)
      || current - at > 10_000 || at - current > 1000) {
    throw new PlatformError("phone_storage_unavailable", "本机加密存储尚未就绪。", { status: 409, retryable: true });
  }
  return Object.freeze(structuredClone(value));
}
