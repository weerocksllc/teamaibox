import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DOCKER_API = /^[0-9]{1,3}\.[0-9]{1,3}$/;
const CODE = /^[a-z][a-z0-9_]{2,127}$/;

function requirements(candidate) {
  const value = candidate?.execution?.preflightRequirements;
  if (!value || value.expectedArchitecture !== "arm64" || !DOCKER_API.test(value.minimumDockerApiVersion ?? "")
      || typeof value.requireNvidiaContainerIntegration !== "boolean"
      || !Array.isArray(value.allowedSecureBootStates) || value.allowedSecureBootStates.length < 1
      || value.allowedSecureBootStates.length > 3 || new Set(value.allowedSecureBootStates).size !== value.allowedSecureBootStates.length
      || value.allowedSecureBootStates.some((state) => !new Set(["enabled", "disabled", "unknown"]).has(state))) {
    throw new TypeError("maintenance candidate preflight requirements are invalid");
  }
  return Object.freeze({ expectedArchitecture: "arm64", minimumDockerApiVersion: value.minimumDockerApiVersion,
    requireNvidiaContainerIntegration: value.requireNvidiaContainerIntegration,
    allowedSecureBootStates: Object.freeze([...value.allowedSecureBootStates]) });
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * Converts the Node Agent's bounded read-only observation into the closed
 * preflight shape consumed by MaintenanceWorkflowService. Node addresses,
 * transport credentials, Docker responses, and arbitrary commands never enter
 * a maintenance candidate or its public plan.
 */
export class NodeAgentMaintenancePreflightInspector {
  #nodes;
  #router;
  #localNodeId;

  constructor({ nodeRepository, nodeAgentRouter, localNodeId }) {
    if (!UUID.test(localNodeId ?? "") || typeof nodeRepository?.findNode !== "function" || typeof nodeAgentRouter?.maintenancePreflight !== "function") {
      throw new TypeError("Node Agent maintenance preflight dependencies are incomplete");
    }
    this.#nodes = nodeRepository;
    this.#router = nodeAgentRouter;
    this.#localNodeId = localNodeId;
  }

  async inspect({ planId, kind, candidate, targetNodes }) {
    if (!UUID.test(planId ?? "") || !new Set(["platform", "host"]).has(kind) || candidate?.kind !== kind
        || !DIGEST.test(candidate?.digest ?? "") || !Array.isArray(targetNodes) || targetNodes.length !== 1
        || targetNodes[0]?.nodeId !== this.#localNodeId) {
      throw new TypeError("maintenance preflight inspection is invalid");
    }
    const expected = requirements(candidate);
    const observations = await Promise.all([...targetNodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)).map(async (target, index) => {
      const node = await this.#nodes.findNode(target.nodeId);
      if (!node || node.nodeId !== this.#localNodeId || !Number.isSafeInteger(node.generation) || node.generation < 1 || !new Set(["ready", "draining"]).has(node.lifecycleState)) {
        return Object.freeze({ nodeId: target.nodeId, passed: false, errorCode: "node_preflight_unavailable" });
      }
      try {
        const value = await this.#router.maintenancePreflight({ nodeId: node.nodeId, nodeGeneration: node.generation,
          planId, kind, candidateDigest: candidate.digest, requirements: expected,
          correlationId: `maintenance:${planId}:preflight:${index + 1}` });
        if (!value || value.nodeId !== node.nodeId || value.nodeGeneration !== node.generation || value.planId !== planId
            || typeof value.passed !== "boolean" || !DIGEST.test(value.evidenceDigest ?? "")
            || !Array.isArray(value.blockers) || !Array.isArray(value.warnings)
            || [...value.blockers, ...value.warnings].some((code) => !CODE.test(code ?? ""))) {
          return Object.freeze({ nodeId: target.nodeId, passed: false, errorCode: "node_preflight_protocol_invalid" });
        }
        return Object.freeze({ nodeId: node.nodeId, passed: value.passed, evidenceDigest: value.evidenceDigest,
          blockers: Object.freeze([...value.blockers]), warnings: Object.freeze([...value.warnings]), secureBootState: value.secureBootState,
          nvidiaContainerIntegrationMode: value.nvidiaContainerIntegrationMode, activeManagedWorkloads: value.activeManagedWorkloads });
      } catch {
        return Object.freeze({ nodeId: target.nodeId, passed: false, errorCode: "node_preflight_unavailable" });
      }
    }));
    const blockers = new Set();
    const warnings = new Set();
    for (const observation of observations) {
      if (observation.errorCode) blockers.add(observation.errorCode);
      for (const code of observation.blockers ?? []) blockers.add(code);
      for (const code of observation.warnings ?? []) warnings.add(code);
    }
    const secureBootCompatible = observations.every((item) => !item.errorCode && !(item.blockers ?? []).includes("secure_boot_state_incompatible"));
    const runtimeBlockers = new Set(["architecture_incompatible", "docker_api_incompatible", "nvidia_container_integration_unavailable"]);
    const runtimeCompatible = observations.every((item) => !item.errorCode && !(item.blockers ?? []).some((code) => runtimeBlockers.has(code)));
    const closed = observations.map((item) => item.errorCode ? { nodeId: item.nodeId, errorCode: item.errorCode }
      : { nodeId: item.nodeId, passed: item.passed, evidenceDigest: item.evidenceDigest });
    return Object.freeze({ passed: observations.every((item) => item.passed === true), blockers: Object.freeze([...blockers].sort()),
      warnings: Object.freeze([...warnings].sort()), secureBootCompatible, runtimeCompatible, evidenceDigest: digest(closed) });
  }
}
