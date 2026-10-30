import { createHash } from "node:crypto";
import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { LEGACY_PHONE_ROM, PHONE_ROM_ID } from "../../../../services/scheduler/src/phone-rom.mjs";

const GiB = 1024 ** 3;
export const PHONE_SPEC = Object.freeze({
  id: "cuttlefish-arm64-office-v1", backend: "cuttlefish", buildId: "16102939",
  androidVersion: "17", apiLevel: 37, abi: "arm64-v8a", renderer: "swiftshader",
  kvm: true, googlePlay: "deferred", gpuAcceleration: false,
  memoryBytes: 6 * GiB, cpuMillis: 2000, guestMemoryMiB: 4096, guestVcpus: 4,
  width: 720, height: 1280, targetFps: 30, storageBytes: 16 * GiB,
});
export const PHONE_POLICY = Object.freeze({ enabled: false, storedPerUser: null, runningPerUser: null,
  phonesPerNode: null, maximumUploadBytes: Number.MAX_SAFE_INTEGER, connectionTtlSeconds: 60,
  adbTtlSeconds: 900, hostMarginBytes: 16 * GiB, baselineSeconds: 30,
  baselineMaxAgeSeconds: 10, memoryPsiAdmissionPercent: 1, memoryPsiStopPercent: 5,
  pressureDurationSeconds: 10, swapOutStopBytesPerSecond: 1024 ** 2,
});
export const PHONE_STATES = Object.freeze(["creating", "stopped", "starting", "running", "stopping",
  "unavailable", "error", "deleting", "deleted"]);
export const OPERATION_ACTIONS = Object.freeze(["create", "start", "stop", "restart", "delete"]);
export const OPERATION_STATES = Object.freeze(["queued", "executing", "succeeded", "failed"]);
export const RUN_STATES = Object.freeze(["reserved", "starting", "running", "stopping", "unavailable", "stopped"]);
export const GRANT_KINDS = Object.freeze(["control", "adb"]);
export const GRANT_STATES = Object.freeze(["issued", "connected", "revoking", "revoked", "expired"]);
const transitions = Object.freeze({
  creating: ["stopped", "error", "unavailable"], stopped: ["starting", "deleting", "unavailable"],
  starting: ["running", "stopping", "error", "unavailable"], running: ["stopping", "unavailable", "error"],
  stopping: ["stopped", "error", "unavailable"], unavailable: ["stopped", "running", "stopping", "error", "deleting"],
  error: ["stopped", "starting", "stopping", "deleting", "unavailable"], deleting: ["deleted", "error", "unavailable"], deleted: [],
});
export const PHONE_ERRORS = Object.freeze({
  phone_input_invalid: [400, "请求内容无效。"], phone_idempotency_required: [400, "请提供操作标识。"],
  phone_permission_required: [403, "没有此操作权限。"], phone_not_found: [404, "未找到这部手机或操作。"],
  phone_disabled: [503, "虚拟手机暂未启用。"], phone_runtime_unavailable: [503, "手机运行服务暂不可用。"],
  phone_rom_unavailable: [409, "此系统版本暂不能新建，请选择其他版本。"],
  phone_rom_not_installed: [409, "本机尚未安装这部手机所需的系统版本。"],
  phone_state_conflict: [409, "手机状态已变化，请刷新后重试。"], phone_operation_conflict: [409, "这部手机正在处理另一项操作。"],
  phone_connection_in_use: [409, "这部手机已在其他页面打开。可点击“在这里连接”切换到当前页面。"],
  phone_idempotency_conflict: [409, "同一操作标识不能用于不同请求。"], phone_stale_run: [409, "运行已变更，旧结果未被采用。"],
  phone_stored_quota: [409, "已达到可保存手机数量上限。"], phone_running_quota: [409, "已达到同时运行手机数量上限。"],
  phone_capacity_unavailable: [409, "本机当前资源不足，请稍后重试。"],
  phone_storage_unavailable: [503, "本机没有就绪的加密手机存储。"], phone_storage_full: [409, "手机存储空间不足。"],
  phone_stop_unconfirmed: [409, "尚未确认手机停止，资源仍保留。"], phone_delete_unconfirmed: [409, "尚未确认手机数据删除。"],
  phone_node_unavailable: [503, "本机手机服务不可用，数据与运行额度已保留。"],
  phone_resource_protection: [409, "本机资源紧张，手机已进入保护流程。"],
  phone_grant_invalid: [403, "连接授权无效或已过期。"], phone_upload_too_large: [413, "文件超过大小限制。"],
  phone_object_invalid: [400, "文件不属于当前用户或校验失败。"], phone_install_failed: [422, "Android 未能安装此应用。"],
});
export function failPhone(code, details = null) {
  const definition = PHONE_ERRORS[code];
  if (!definition) throw new TypeError("Unknown virtual phone error code");
  throw new PlatformError(code, definition[1], { status: definition[0], details,
    retryable: ["phone_capacity_unavailable", "phone_node_unavailable", "phone_runtime_unavailable"].includes(code) });
}
export function phoneErrorCode(error) { return Object.hasOwn(PHONE_ERRORS, error?.code) ? error.code : "phone_runtime_unavailable"; }
export function record(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) failPhone("phone_input_invalid");
  return value;
}
export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) failPhone("phone_input_invalid");
  return value;
}
export function identifier(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    failPhone("phone_input_invalid");
  }
  return value.toLowerCase();
}
export function phoneName(value) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) failPhone("phone_input_invalid");
  const name = value.trim().normalize("NFC");
  if (!name.length) failPhone("phone_input_invalid");
  return name;
}
export function idempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) failPhone("phone_idempotency_required");
  return value;
}
export function requestFingerprint(value) {
  // Only validated, normalized requests enter here; sort keys for consistent retries.
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function validateCreate(input) {
  record(input, ["name", "start", "romVersionId"]);
  if (input.start !== undefined && typeof input.start !== "boolean") failPhone("phone_input_invalid");
  if (input.romVersionId !== undefined && (typeof input.romVersionId !== "string" || !PHONE_ROM_ID.test(input.romVersionId))) failPhone("phone_input_invalid");
  // Keep old persisted request fingerprints valid, including an explicit choice
  // of the original AOSP. Every other version participates in idempotency.
  return { name: phoneName(input.name), start: input.start ?? true,
    ...(input.romVersionId && input.romVersionId !== LEGACY_PHONE_ROM ? { romVersionId: input.romVersionId } : {}) };
}
export function validateAction(action, input) {
  if (!OPERATION_ACTIONS.includes(action) || action === "create") failPhone("phone_input_invalid");
  record(input, action === "delete" ? ["expectedRevision", "confirmDelete"] : ["expectedRevision"]);
  const result = { expectedRevision: integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER) };
  if (action === "delete") {
    if (input.confirmDelete !== true) failPhone("phone_input_invalid");
    result.confirmDelete = true;
  }
  return result;
}
export function validateRename(input) {
  record(input, ["name", "expectedRevision"]);
  return { name: phoneName(input.name), expectedRevision: integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER) };
}
export function validateQuota(input) {
  record(input, ["storedPerUser", "runningPerUser"]);
  // This is an administrator quota, not a runtime capacity assertion. The
  // scheduler separately admits each phone against its node's live resources.
  const storedPerUser = input.storedPerUser === null ? null : integer(input.storedPerUser, 0, 2 ** 31 - 1);
  const runningPerUser = input.runningPerUser === null ? null : integer(input.runningPerUser, 0, storedPerUser ?? 2 ** 31 - 1);
  return { storedPerUser, runningPerUser };
}
export function validateQuotaUpdate(input) {
  record(input, ["storedPerUser", "runningPerUser", "expectedRevision"]);
  return { ...validateQuota({ storedPerUser: input.storedPerUser, runningPerUser: input.runningPerUser }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) }) };
}
export function validateFeatureUpdate(input) {
  record(input, ["enabled", "expectedRevision"]);
  if (typeof input.enabled !== "boolean") failPhone("phone_input_invalid");
  return { enabled: input.enabled, expectedRevision: integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) };
}
export function validateQuotaQuery(input = {}) {
  record(input, ["search", "after"]);
  if (input.search !== undefined && (typeof input.search !== "string" || /[\p{Cc}\p{Cf}]/u.test(input.search))) failPhone("phone_input_invalid");
  return { search: (input.search ?? "").trim(), after: input.after ? identifier(input.after) : null };
}
export function validatePolicy(input = {}) {
  record(input, ["enabled", "storedPerUser", "runningPerUser", "phonesPerNode", "maximumUploadBytes"]);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") failPhone("phone_input_invalid");
  return Object.freeze({ ...PHONE_POLICY, ...input,
    ...validateQuota({ storedPerUser: input.storedPerUser ?? PHONE_POLICY.storedPerUser,
      runningPerUser: input.runningPerUser ?? PHONE_POLICY.runningPerUser }),
    phonesPerNode: input.phonesPerNode == null ? null : integer(input.phonesPerNode, 0, Number.MAX_SAFE_INTEGER),
    maximumUploadBytes: integer(input.maximumUploadBytes ?? PHONE_POLICY.maximumUploadBytes, 1, PHONE_POLICY.maximumUploadBytes),
  });
}
export function assertTransition(from, to) {
  if (!transitions[from]?.includes(to)) failPhone("phone_state_conflict");
}
export function validateRunIdentity(input) {
  record(input, ["phoneId", "ownerId", "runId", "generation", "nodeId", "nodeGeneration"]);
  return { phoneId: identifier(input.phoneId), ownerId: identifier(input.ownerId), runId: identifier(input.runId),
    generation: integer(input.generation, 1, Number.MAX_SAFE_INTEGER), nodeId: identifier(input.nodeId),
    nodeGeneration: integer(input.nodeGeneration, 1, Number.MAX_SAFE_INTEGER) };
}
export function validateGrant(input) {
  record(input, ["kind", "ttlSeconds"]);
  if (!GRANT_KINDS.includes(input.kind)) failPhone("phone_input_invalid");
  const limit = input.kind === "adb" ? PHONE_POLICY.adbTtlSeconds : PHONE_POLICY.connectionTtlSeconds;
  return { kind: input.kind, ttlSeconds: integer(input.ttlSeconds ?? limit, 1, limit) };
}
export function validateConnectionRequest(input) {
  record(input, ["kind", "ttlSeconds", "takeover"]);
  if (input.takeover !== undefined && typeof input.takeover !== "boolean") failPhone("phone_input_invalid");
  if (input.takeover === true && input.kind !== "control") failPhone("phone_input_invalid");
  return {...validateGrant({kind:input.kind,ttlSeconds:input.ttlSeconds}),takeover:input.takeover === true};
}
