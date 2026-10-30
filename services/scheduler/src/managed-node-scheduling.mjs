const RESOURCE_KEYS = Object.freeze([
  "cpuMillis",
  "unifiedMemoryBytes",
  "acceleratorUnits",
  "codecSessions",
  "storageBytes",
  "networkBitsPerSecond",
]);

function nonnegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function resourceVector(inventory) {
  const resources = inventory?.resources;
  return {
    cpuMillis: resources?.cpu?.availableMillis,
    unifiedMemoryBytes: resources?.unifiedMemory?.availableBytes,
    acceleratorUnits: resources?.accelerator?.units,
    codecSessions: resources?.codecs?.sessions,
    storageBytes: resources?.storage?.availableBytes,
    networkBitsPerSecond: resources?.network?.availableBitsPerSecond,
  };
}

// These are observed facts, not a pool available for advance booking.
export function projectManagedNodeAvailableResources(inventory) {
 const observed = resourceVector(inventory);
 return Object.freeze(Object.fromEntries(RESOURCE_KEYS.map(key => [key, nonnegative(observed[key], key)])));
}
export function projectManagedNodeLeaseCapacity(inventory) {
 const observed = projectManagedNodeAvailableResources(inventory);
 const codec = inventory?.schedulerFacts?.codec;
 return Object.freeze({...observed, codec:Object.freeze({encodeSessions:nonnegative(codec?.encodeSessions ?? 0,"codec.encodeSessions"), decodeSessions:nonnegative(codec?.decodeSessions ?? 0,"codec.decodeSessions")})});
}

function networkFacts(inventory) {
  const healthy = (inventory.networkLinks ?? []).filter((link) => link.health === "healthy");
  const classNames = new Set();
  for (const link of healthy) {
    if (link.networkClass === "10gbe") classNames.add("lan_10gbe");
    else classNames.add(link.networkClass);
  }
  return Object.freeze({
    classes: Object.freeze([...classNames].sort()),
    latencyMilliseconds: healthy.length
      ? Math.min(...healthy.map((link) => link.latencyMicroseconds)) / 1_000
      : null,
  });
}

function profileRecord(value) {
  if (!value) return null;
  if (value.profile && value.fingerprint) return value;
  return { profile: value, fingerprint: value.fingerprint ?? null };
}

/**
 * Expands authenticated node inventory into the exact target/profile pairs
 * consumed by the pure routing engine. Physical addresses and credentials are
 * deliberately absent from the projection.
 */
export class ManagedNodeSchedulingCatalog {
  #nodes;
  #profiles;
  #localNodeId;

  constructor({ nodeRepository, profileCatalog, localNodeId }) {
    if (typeof nodeRepository?.findNode !== "function"
        || (typeof profileCatalog?.findByIds !== "function" && typeof profileCatalog?.findById !== "function")) {
      throw new TypeError("managed node scheduling catalog dependencies are incomplete");
    }
    this.#nodes = nodeRepository;
    if (!localNodeId) throw new TypeError("Scheduling requires the local appliance identity");
    this.#localNodeId = localNodeId;
    this.#profiles = profileCatalog;
  }

  async #resolveProfiles(ids) {
    if (typeof this.#profiles.findByIds === "function") {
      const records = await this.#profiles.findByIds(ids);
      return new Map(records.map((value) => {
        const record = profileRecord(value);
        return [record.profile.profileId, record];
      }));
    }
    const records = await Promise.all(ids.map((id) => this.#profiles.findById(id)));
    return new Map(records.filter(Boolean).map((value) => {
      const record = profileRecord(value);
      return [record.profile.profileId, record];
    }));
  }

  async candidatesFor(job) {
    if (!job?.jobId || !job.capabilityId || !job.capabilityKey) {
      throw new TypeError("managed node candidate expansion requires durable job identity and capability");
    }
    const local = await this.#nodes.findNode(this.#localNodeId);
    const nodes = local?.nodeId === this.#localNodeId ? [local] : [];
    const advertisedIds = [...new Set(nodes.flatMap((node) =>
      (node.inventory?.modelProfiles ?? []).map((profile) => profile.profileId)))];
    const profiles = await this.#resolveProfiles(advertisedIds);
    const candidates = [];

    for (const node of nodes) {
      if (!node.inventory || node.lifecycleState !== "ready" || node.health?.state !== "healthy") continue;
      const capability = node.inventory.capabilities.find((item) => item.capabilityKey === job.capabilityKey);
      if (!capability || capability.state !== "available") continue;
      const facts = node.inventory.schedulerFacts;
      for (const advertised of node.inventory.modelProfiles) {
        const record = profiles.get(advertised.profileId);
        const profile = record?.profile;
        if (!profile || advertised.lifecycleState !== "certified"
            || profile.certification?.state !== "certified"
            || advertised.profileKey !== profile.profileKey
            || advertised.profileFingerprint !== record.fingerprint
            || profile.capabilityId !== job.capabilityId) continue;
        candidates.push(Object.freeze({
          targetId: node.nodeId,
          targetKind: "managed_node",
          nodeGeneration: node.generation,
          lifecycleState: "ready",
          architecture: node.architecture,
          operations: Object.freeze([...advertised.operations]),
          profile: Object.freeze(structuredClone(profile)),
          availableResources: projectManagedNodeAvailableResources(node.inventory),
          accelerator: Object.freeze(structuredClone(facts.accelerator)),
          codec: Object.freeze({
            encode: facts.codec.encodeSessions,
            decode: facts.codec.decodeSessions,
          }),
          storage: Object.freeze({ classes: Object.freeze([...facts.storage.classes]) }),
          network: networkFacts(node.inventory),
          loadCost: Object.freeze({
            workerState: facts.workerState,
            coldStartMilliseconds: profile.coldStart?.estimatedMilliseconds ?? null,
            modelArtifactCached: facts.modelArtifactCached,
          }),
          locality: Object.freeze({
            inputArtifactIds: Object.freeze([...(facts.inputArtifactIds ?? [])]),
            modelArtifactCached: facts.modelArtifactCached,
            preferredNode: false,
          }),
          routingWeight: Number(node.labels?.routingWeight ?? 100),
          resourceAccountingMode: "observed",
        }));
      }
    }
    return Object.freeze(candidates.sort((left, right) =>
      left.targetId.localeCompare(right.targetId)
      || left.profile.profileId.localeCompare(right.profile.profileId)));
  }
}

export const managedNodeResourceKeys = RESOURCE_KEYS;
