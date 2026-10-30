import { validateAndroidPhoneCommand, validateAndroidPhoneResult } from "../../../../services/scheduler/src/android-phone-command.mjs";
import { identifier, PHONE_SPEC, failPhone } from "./contracts.mjs";
import { phoneApprovedNodes } from "../../../../services/scheduler/src/phone-approved-nodes.mjs";
import { installedPhoneRom, installedPhoneRuntime } from "../../../../services/scheduler/src/phone-rom.mjs";

/** Projects persisted control facts into the existing authenticated Agent route.
 * It cannot enable a deployment without a real access revoker. In particular,
 * closing a signalling socket is not a substitute for revoking a media peer.
 */
export class ManagedNodePhoneRuntime {
  #router; #nodes; #access;
  constructor({ nodeAgentRouter, approvedNodes, accessRevoker }) {
    if (typeof nodeAgentRouter?.executePhoneCommand !== "function" || typeof nodeAgentRouter?.resolvePhoneNode !== "function" || !Array.isArray(approvedNodes)
        || typeof accessRevoker?.revokePhoneAccess !== "function") throw new TypeError("Phone runtime dependencies are incomplete");
    this.#nodes = phoneApprovedNodes(approvedNodes);
    this.#router = nodeAgentRouter; this.#access = accessRevoker;
  }
  #binding(phone, run) {
    const node = this.#nodes.get(phone?.nodeId);
    if (!node || node.poolId !== phone.poolId) failPhone("phone_node_unavailable");
    const installed = installedPhoneRuntime(node, phone, run?.imageDigest);
    if (!installedPhoneRom(node, phone.romVersionId, phone.rom?.imageDigest)) failPhone("phone_rom_not_installed");
    if (!installed) failPhone("phone_stale_run");
    for (const key of ["id", "ownerId", "volumeId"]) identifier(phone[key]);
    if (phone.baseBuildId !== PHONE_SPEC.buildId || phone.specId !== PHONE_SPEC.id || phone.storageBytes !== PHONE_SPEC.storageBytes
        || !Number.isSafeInteger(phone.generation) || phone.generation < 0) failPhone("phone_state_conflict");
    if (run && (run.phoneId !== phone.id || run.ownerId !== phone.ownerId || run.nodeId !== phone.nodeId
        || !Number.isSafeInteger(run.nodeGeneration) || run.nodeGeneration < node.nodeGeneration || run.generation !== phone.generation || run.imageDigest !== installed.imageDigest
        || run.memoryBytes !== PHONE_SPEC.memoryBytes || run.cpuMillis !== PHONE_SPEC.cpuMillis)) failPhone("phone_stale_run");
    return node;
  }
  async #execute(action, { phone, run, operationId }) {
    const node = this.#binding(phone, run);
    const current = await this.#router.resolvePhoneNode({nodeId:node.nodeId,minimumGeneration:node.nodeGeneration});
    if (run && run.nodeGeneration > current.nodeGeneration) failPhone("phone_stale_run");
    const payload = validateAndroidPhoneCommand(action, {
      phoneId: phone.id, ownerId: phone.ownerId, volumeId: phone.volumeId, poolId: phone.poolId, baseBuildId: phone.baseBuildId,
      operationId: identifier(operationId), generation: phone.generation,
      ...(run ? { run: { id: run.id, reservationId: run.reservationId, imageDigest: run.imageDigest,
        memoryBytes: run.memoryBytes, cpuMillis: run.cpuMillis } } : {}),
    });
    let value;
    try {
      value = await this.#router.executePhoneCommand({ nodeId: node.nodeId, nodeGeneration: current.nodeGeneration,
        action, payload, correlationId: `phone:${operationId}` });
    } catch (error) {
      if (["node_agent_transport_unavailable", "managed_node_not_found", "managed_node_not_ready", "stale_node_generation"].includes(error?.code)) {
        failPhone("phone_node_unavailable");
      }
      throw error;
    }
    return validateAndroidPhoneResult(action, payload, value);
  }
  provision(input) { return this.#execute("provision", input); }
  hasConfiguredLocation(phone) { return this.#nodes.get(phone.nodeId)?.poolId === phone.poolId; }
  async revokeRetiredRecordAccess(phone) {
    if (this.hasConfiguredLocation(phone) || phone.runningCharged) failPhone('phone_state_conflict');
    const result = await this.#access.revokePhoneAccess({ phoneId: phone.id, ownerId: phone.ownerId,
      runId: null, generation: phone.generation, operationId: null, loginSessionId: null, reason: 'retired_record_removal' });
    if (result?.accessRevoked !== true || result.phoneId !== phone.id || result.runId !== null) failPhone('phone_grant_invalid');
  }
  start(input) { return this.#execute("start", input); }
  stop(input) { return this.#execute("stop", input); }
  inspect(input) { return this.#execute("inspect", input); }
  deleteData(input) { return this.#execute("delete", input); }
  async revokeAccess({ phone, run, operationId, loginSessionId, reason }) {
    this.#binding(phone, run);
    const result = await this.#access.revokePhoneAccess({ phoneId: phone.id, ownerId: phone.ownerId,
      runId: run?.id ?? null, generation: phone.generation, operationId: operationId ?? null,
      loginSessionId: loginSessionId ?? null, reason: reason ?? "lifecycle" });
    if (result?.accessRevoked !== true || result.phoneId !== phone.id || result.runId !== (run?.id ?? null)) failPhone("phone_grant_invalid");
    return result;
  }
}
