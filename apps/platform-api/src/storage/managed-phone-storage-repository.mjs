import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { phoneApprovedNodes } from "../../../../services/scheduler/src/phone-approved-nodes.mjs";
import { phoneStorageObservation } from "../../../../services/scheduler/src/phone-storage-observation.mjs";
import { PostgresStorageAdministrationRepository } from "./postgres-storage-administration-repository.mjs";

const fail = () => { throw new PlatformError("phone_storage_unavailable", "本机手机存储尚未就绪。", { status: 409, retryable: true }); };
const onlyPhones = classes => Array.isArray(classes) && classes.length === 1 && classes[0] === "phone-data";

// Register the local phone pool using measurements from this appliance.
export class ManagedPhoneStorageRepository {
  #delegate; #database; #router; #pools; #clock; #localNodeId;
  constructor({ repository, database, nodeAgentRouter, approvedNodes, localNodeId, clock = () => new Date() }) {
    if (!repository?.bindContext || !database?.transaction || !nodeAgentRouter?.readPhoneStorage || !nodeAgentRouter?.resolvePhoneNode) throw TypeError("Managed phone storage dependencies are incomplete");
    this.#delegate = repository; this.#database = database; this.#router = nodeAgentRouter; this.#clock = clock;
    this.#localNodeId = localNodeId;
    this.#pools = new Map([...phoneApprovedNodes(approvedNodes).values()].map(node => [node.poolId, node]));
    if (!localNodeId || this.#pools.size !== 1 || approvedNodes.length !== 1 || approvedNodes[0].nodeId !== localNodeId) throw TypeError("Phone storage requires the single local appliance pool");
  }

  bindContext(context) {
    const base = this.#delegate.bindContext(context);
    const manage = () => {
      if (!context?.identityId || !context.permissions?.includes("storage:manage")) {
        throw new PlatformError("storage_permission_required", "Storage management permission is required", { status: 403 });
      }
    };
    return {
      list: () => base.list(), find: id => base.find(id),
      create: async input => {
        manage();
        if (input.nodeId !== this.#localNodeId) fail();
        const approved = this.#pools.get(input.poolId);
        if (!approved) {
          if (input.dataClasses?.includes("phone-data")) fail();
          return base.create(input);
        }
        if (input.nodeId !== approved.nodeId || input.backendKind !== "local-block" || input.encryptionMode !== "luks2"
            || !onlyPhones(input.dataClasses) || input.safetyReserveBytes !== 0) fail();
        // The only values persisted as verified come from the authenticated
        // installed helper. User-entered byte counts cannot mark a pool ready.
        const currentNode = await this.#router.resolvePhoneNode({nodeId:approved.nodeId,minimumGeneration:approved.nodeGeneration});
        const observation = phoneStorageObservation(await this.#router.readPhoneStorage({ ...currentNode,
          correlationId: "phone-pool-register" }), { ...approved, ...currentNode, now: this.#clock() });
        if (input.safetyReserveBytes >= observation.totalBytes) fail();
        return this.#database.transaction(async db => {
          const node = (await db.query(`SELECT generation,lifecycle_state,recovery_state,trust_kind,appliance_role,architecture
            FROM compute.nodes WHERE id=$1 FOR UPDATE`, [approved.nodeId])).rows[0];
          if (!node || Number(node.generation) !== currentNode.nodeGeneration || node.lifecycle_state !== "ready" || node.recovery_state !== "healthy"
              || node.trust_kind !== "managed_appliance" || node.appliance_role !== "appliance-core" || !["arm64", "aarch64"].includes(node.architecture)) fail();
          phoneStorageObservation(observation, { ...approved, ...currentNode, now: this.#clock() });
          const current = await db.query(`SELECT status FROM iam.identities WHERE id=$1`, [context.identityId]);
          if (current.rows[0]?.status !== "active") throw new PlatformError("storage_permission_required", "Identity is inactive", { status: 403 });
          // Reuse the repository's existing atomic pool/class insertion within
          // this transaction and node-generation lock, not a second connection.
          const scoped = new PostgresStorageAdministrationRepository({ database: { query: db.query, transaction: f => f(db) } });
          return scoped.create({ ...input, totalBytes: observation.totalBytes, availableBytes: observation.availableBytes,
            observedAt: new Date(observation.observedAt) });
        });
      },
      replaceDataClasses: async input => {
        manage();
        if (this.#pools.has(input.poolId)) {
          if (!onlyPhones(input.dataClasses)) fail();
          const current = await base.find(input.poolId);
          if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
          return current; // Already phone-only; never enable blob placement here.
        }
        if (input.dataClasses?.includes("phone-data")) fail();
        return base.replaceDataClasses(input);
      },
      transition: async input => {
        manage();
        // Keep the existing object service's lifecycle coordination; database
        // guards additionally prevent retirement while phone disks remain.
        return base.transition(input);
      },
    };
  }
}
