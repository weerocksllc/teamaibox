/** Finite first-install catalog commit. No Docker mutation or synthetic health.
 * The root installer supplies freshly inspected, installation-owned workers.
 * Normal application readiness still performs live Node Agent inspection.
 */
const SHA = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ['workerId', 'modelProfileId', 'imageDigest', 'configurationDigest', 'placementClass', 'maintenanceGeneration'];
function need(value, text) { if (!value) throw new Error(text); }

export function observations(input, now = Date.now()) {
  need(input?.schemaVersion === 1 && UUID.test(input.installationId) && UUID.test(input.nodeId), 'Invalid fresh-install observation identity');
  need(input.setId === 'factory-office-' + input.installationId, 'Invalid fresh-install set');
  need(Array.isArray(input.profiles) && input.profiles.length === 6 && Array.isArray(input.workers)
    && input.workers.length === 6 && new Set(input.workers.map(w => w.workerId)).size === 6, 'Six exact workers are required');
  const age = now - Date.parse(input.observedAt);
  need(age >= -1000 && age < 15000, 'Installation observations expired; collect fresh state');
  for (const p of input.profiles) {
    const w = input.workers.find(w => w.workerId === p.workerId);
    need(UUID.test(p.workerId) && UUID.test(p.modelProfileId) && SHA.test(p.imageDigest)
      && SHA.test(p.configurationDigest) && p.placementClass === 'protected-resident' && p.maintenanceGeneration === 1,
    'Invalid factory profile identity');
    need(w && FIELDS.every(k => p[k] === w[k]) && w.healthy === true && w.state === 'running'
      && /^[0-9a-f]{64}$/.test(w.containerId) && Number.isFinite(Date.parse(w.startedAt))
      && Number.isSafeInteger(w.residentBytes) && w.residentBytes > 0 && w.residentBytes <= p.declaredResidentBytes,
    'New worker is not healthy or does not match its declaration');
  }
  need(input.coreHealthy === true && input.memorySnapshot?.observedAt === input.observedAt,
    'Core/memory observations incomplete');
  return input;
}

export async function commit(input, { database, repository, Coordinator }) {
  observations(input);
  const manifest = { setId: input.setId, nodeId: input.nodeId, desiredStateRevision: 1,
    maintenanceGeneration: 1, profiles: input.profiles,
    requiredModelProfileIds: input.profiles.map(p => p.modelProfileId) };
  const inspect = async ({ profile }) => {
    observations(input); // Never keep using a stale capture through a slow DB.
    const w = input.workers.find(w => w.workerId === profile.workerId);
    need(w && FIELDS.every(k => w[k] === profile[k]), 'Installation runtime identity changed');
    return structuredClone(w);
  };
  const runtime = {
    inspectProtectedProfile: inspect, probeProtectedProfile: inspect,
    async transitionProtectedSet({ profiles }) {
      // Containers were already created and loaded by the existing boot
      // adapter. Only register that observed set; do not start them again.
      for (const profile of profiles) await inspect({ profile });
      return { reusedExistingHealthyWorkers: true };
    },
    async restoreProtectedProfile({ profile, previousIdentity }) {
      const actual = await inspect({ profile });
      need(previousIdentity && FIELDS.every(k => actual[k] === previousIdentity[k])
        && previousIdentity.healthy === true, 'Interrupted registration needs inspection');
      return actual;
    },
  };
  const coordinator = new Coordinator({ repository, runtime,
    memorySnapshotProvider: { snapshot: async () => { observations(input); return structuredClone(input.memorySnapshot); } },
    coreServiceProbe: async () => { observations(input); return { healthy: input.coreHealthy }; } });
  // A process interruption may have left a metadata transaction open. Recover
  // only this new set through the existing repository/coordinator state rules.
  const incomplete = await repository.listIncompleteTransactions({ setId: input.setId });
  for (const tx of incomplete) {
    need(tx.nodeId === input.nodeId && tx.manifest.profiles.every(p => input.profiles.some(w =>
      FIELDS.every(k => p[k] === w[k]))), 'Unrelated office transaction preserved');
    await coordinator.recover({ transactionId: tx.transactionId });
  }
  const result = await coordinator.boot({ manifest });
  need(result.state === 'healthy', 'Factory office set did not commit');
  await database.query(`UPDATE compute.model_profiles SET observed_state_revision=desired_state_revision,
    recovery_state='healthy',recovery_reason_code=NULL
    WHERE id=ANY($1::uuid[]) AND placement_class='protected-resident' AND maintenance_generation=1`,
  [input.profiles.map(p => p.modelProfileId)]);
  return { status: 'ready', reused: result.reused, modelsStarted: false, setId: input.setId };
}

export async function main(input) {
  const root = '/opt/teamaibox';
  const { createPostgresDatabaseFromEnvironment } = await import(root + '/packages/persistence/src/postgres-database.mjs');
  const { PostgresProtectedOfficeSetRepository } = await import(root + '/services/scheduler/src/postgres-protected-office-set-repository.mjs');
  const { ProtectedOfficeSetCoordinator } = await import(root + '/services/scheduler/src/protected-office-set-coordinator.mjs');
  const database = await createPostgresDatabaseFromEnvironment();
  try {
    const repository = new PostgresProtectedOfficeSetRepository({ database });
    return await commit(input, { database, repository, Coordinator: ProtectedOfficeSetCoordinator });
  } finally { await database.close(); }
}
