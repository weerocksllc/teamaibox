import { protectedOfficeCatalogProfiles } from '../src/applications/protected-office-catalog-repository.mjs';
import { readFile } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTITY = ['workerId', 'modelProfileId', 'imageDigest', 'configurationDigest',
  'placementClass', 'maintenanceGeneration'];

// Reads the Agent's installed target policy, not an acceptance plan, captured
// lease or Docker socket. The catalog separately rechecks the committed set
// after inspection so a concurrent maintenance transition cannot advertise it.
export function createApplianceProtectedOfficeRuntime(environment, { nodeRepository, nodeAgentRouter,
  readBootStatus = async () => environment.PLATFORM_AI_BOOT_STATUS_FILE
    ? JSON.parse(await readFile(environment.PLATFORM_AI_BOOT_STATUS_FILE, 'utf8')) : null,
  clock = () => Date.now() }) {
  if (!environment.PLATFORM_PROTECTED_OFFICE_SET_ID) return null;
  const nodeId = environment.PLATFORM_APPLIANCE_NODE_ID;
  const policyDigest = environment.PLATFORM_APPLIANCE_PROTECTED_TARGET_POLICY_DIGEST;
  const profiles = protectedOfficeCatalogProfiles(environment);
  if (!UUID.test(nodeId ?? '') || environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID !== nodeId
      || !DIGEST.test(policyDigest ?? '') || !nodeRepository?.findNode || !nodeAgentRouter?.inspectAppliance
      || profiles.some(p => !UUID.test(p.workerId ?? '') || !UUID.test(p.profileId ?? ''))
      || new Set(profiles.map(p => p.workerId)).size !== 6 || new Set(profiles.map(p => p.profileId)).size !== 6) {
    throw new TypeError('Local protected office inspection requires the exact appliance, six profiles and installed target policy digest');
  }
  let pending = null;
  async function bootProgress() {
    try {
      const value = await readBootStatus();
      const age = clock() - Date.parse(value?.updatedAt);
      if (value?.nodeId === nodeId && value?.schemaVersion === 1 && age >= 0 && age < 180_000
          && value?.status === 'recovering' && value.workers && typeof value.workers === 'object') return value;
    } catch { /* No stale/missing file may manufacture readiness. */ }
    return null;
  }
  async function inspect() {
    const node = await nodeRepository.findNode(nodeId);
    if (node?.nodeId !== nodeId || node.lifecycleState !== 'ready'
        || !Number.isSafeInteger(node.generation) || node.generation < 1) {
      throw new TypeError('Local protected office appliance is not ready');
    }
    const result = await nodeAgentRouter.inspectAppliance({ nodeId, nodeGeneration: node.generation,
      correlationId: `protected-office-inspect:${nodeId}` });
    if (result?.nodeId !== nodeId || result.nodeGeneration !== node.generation || result.healthy !== true
        || result.protectedTargetPolicyDigest !== policyDigest || !Array.isArray(result.runtimeIdentities)
        || result.runtimeIdentities.length !== 6
        || new Set(result.runtimeIdentities.map(p => p.workerId)).size !== 6
        || profiles.some(p => !result.runtimeIdentities.some(i => i.workerId === p.workerId))) {
      throw new TypeError('Local protected office inspection identity or policy drifted');
    }
    return { identities: result.runtimeIdentities, boot: await bootProgress() };
  }
  return Object.freeze({
    // Presentation only. This path must work even when the Agent/heartbeat is
    // unavailable; these states cannot authorize a route or report readiness.
    async inspectStartupStates() {
      const boot = await bootProgress();
      return new Map(profiles.map(p => {
        const phase = boot?.workers?.[p.workerId]?.phase;
        return [p.workerId, phase === 'retrying' ? 'retrying'
          : ['queued', 'loading', 'waiting'].includes(phase) ? 'loading'
          : phase === 'failed' ? 'failed' : 'unavailable'];
      }));
    },
    async inspectProtectedProfile({ profile }) {
      const expected = profiles.find(p => p.workerId === profile?.workerId);
      if (!expected || expected.profileId !== profile.modelProfileId) {
        throw new TypeError('Protected office profile is not installed on this appliance');
      }
      if (!pending) {
        pending = inspect().finally(() => { pending = null; });
      }
      const { identities, boot } = await pending;
      const observed = identities.find(p => p.workerId === profile.workerId);
      if (observed?.identityExact !== true) throw new TypeError('Protected office runtime identity is unavailable');
      const actual = { workerId: observed.workerId, modelProfileId: observed.modelProfileId,
        imageDigest: observed.image?.match(/(?:^|@)(sha256:[a-f0-9]{64})$/)?.[1],
        configurationDigest: observed.configDigest, placementClass: observed.placementClass,
        maintenanceGeneration: observed.maintenanceGeneration, containerId: observed.containerId,
        startedAt: observed.startedAt, state: observed.status,
        healthy: observed.status === 'running' && observed.health === 'healthy' };
      if (IDENTITY.some(key => actual[key] !== profile[key])
          || !/^[a-f0-9]{64}$/.test(actual.containerId ?? '') || !Number.isFinite(Date.parse(actual.startedAt ?? ''))) {
        throw new TypeError('Protected office runtime differs from the committed profile');
      }
      const phase = boot?.workers?.[profile.workerId]?.phase;
      const startupState = actual.healthy ? 'ready'
        : phase === 'retrying' ? 'retrying'
        : ['queued', 'loading', 'waiting'].includes(phase) ? 'loading'
        : observed.status === 'running' && observed.health === 'starting' ? 'loading'
        : observed.health === 'unhealthy' || ['exited', 'dead'].includes(observed.status) ? 'failed'
        : 'unavailable';
      return Object.freeze({ ...actual, startupState });
    },
  });
}
