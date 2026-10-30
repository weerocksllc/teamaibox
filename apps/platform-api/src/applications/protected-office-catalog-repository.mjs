import { isDeepStrictEqual } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFINITIONS = Object.freeze([
  ["chat", "LOCAL_OPENAI"], ["image-generation", "DRAWING"], ["ocr", "OCR"],
  ["asr", "ASR"], ["translation", "TRANSLATION"], ["embedding", "EMBEDDING"],
]);
const IDENTITY_FIELDS = ["workerId", "modelProfileId", "imageDigest", "configurationDigest",
  "placementClass", "maintenanceGeneration", "containerId", "startedAt"];
function stableState(state) {
  if (!state) return null;
  const { last_seen_at, ...stable } = state;
  return stable;
}

export function protectedOfficeCatalogProfiles(environment) {
  return DEFINITIONS.map(([capabilityKey, prefix]) => ({ capabilityKey,
    profileId: environment[`${prefix}_PROFILE_ID`], profileKey: environment[`${prefix}_PROFILE_KEY`],
    workerId: environment[`${prefix}_WORKER_ID`],
  }));
}

/** Read the canonical protected set, never manufacture legacy Worker rows.
 * A committed identity alone is not liveness: every cache refresh uses the
 * existing authenticated, read-only Node Agent inspection boundary.
 */
export class ProtectedOfficeCatalogRepository {
  #repository; #database; #runtime; #setId; #nodeId; #profiles; #clock;
  #inspection = null; #pending = null;

  constructor({ repository, database, runtime, setId, nodeId, profiles, clock = () => Date.now() }) {
    if (!repository?.snapshot || !database?.query || !runtime?.inspectProtectedProfile
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(setId ?? "") || !UUID.test(nodeId ?? "")
        || !Array.isArray(profiles) || profiles.length !== 6
        || new Set(profiles.map((p) => p.capabilityKey)).size !== 6
        || profiles.some((p) => !DEFINITIONS.some(([key]) => key === p.capabilityKey)
          || !UUID.test(p.profileId ?? "") || !UUID.test(p.workerId ?? "")
          || !/^[a-z][a-z0-9._-]{2,191}$/.test(p.profileKey ?? ""))
        || new Set(profiles.map((p) => p.workerId)).size !== 6
        || new Set(profiles.map((p) => p.profileId)).size !== 6) {
      throw new TypeError("Protected office application catalog bindings are incomplete");
    }
    this.#repository = repository; this.#database = database; this.#runtime = runtime;
    this.#setId = setId; this.#nodeId = nodeId; this.#profiles = structuredClone(profiles); this.#clock = clock;
  }

  async #state() {
    return (await this.#database.query(`SELECT protected_set.*, journal.manifest,
      node.lifecycle_state AS node_state, node.generation AS node_generation,
      node.last_seen_at,
      EXISTS (SELECT 1 FROM compute.protected_office_set_transactions active
        WHERE active.set_id=protected_set.set_id
          AND active.transaction_state NOT IN ('succeeded','rolled-back')) AS active_transaction
      FROM compute.protected_office_sets protected_set
      JOIN compute.protected_office_set_transactions journal ON journal.id=protected_set.last_transaction_id
      JOIN compute.nodes node ON node.id=protected_set.node_id
      WHERE protected_set.set_id=$1 AND protected_set.node_id=$2`, [this.#setId, this.#nodeId])).rows[0];
  }

  async #readiness(state, registrations) {
    const profiles = state?.manifest?.profiles, identities = state?.healthy_identities;
    const age = this.#clock() - new Date(state?.last_seen_at).getTime();
    if (!state || state.recovery_state !== "healthy" || state.active_transaction
        || state.node_state !== "ready" || !(age >= 0 && age < 120_000)
        || Number(state.desired_state_revision) !== Number(state.observed_state_revision)
        || Number(state.observed_state_revision) < 1
        || !Array.isArray(profiles) || profiles.length !== 6
        || !Array.isArray(identities) || identities.length !== 6
        || registrations.length !== 6) return new Map();
    const valid = new Set();
    for (const expected of this.#profiles) {
      const p = profiles.find((p) => p.workerId === expected.workerId);
      const i = identities.find((i) => i.workerId === expected.workerId);
      const r = registrations.find((r) => r.id === expected.profileId);
      if (!p || p.modelProfileId !== expected.profileId || !i || i.healthy !== true || i.state !== "running"
          || !r || r.profile_key !== expected.profileKey || r.capability_key !== expected.capabilityKey
          || r.placement_class !== "protected-resident"
          || !["certified", "experimental", "validating"].includes(r.certification_state)
          || IDENTITY_FIELDS.slice(0, 6).some((key) => i[key] !== p[key])) continue;
      valid.add(expected.workerId);
    }
    const cacheKey = JSON.stringify([state.revision, state.node_generation, profiles, identities, registrations]);
    let inspection = this.#inspection;
    if (!inspection || inspection.key !== cacheKey || this.#clock() - inspection.observedAt >= 5_000
        || this.#clock() < inspection.observedAt) {
      if (!this.#pending || this.#pending.key !== cacheKey) {
        const promise = Promise.all(profiles.map(async (profile) => {
          try { return await this.#runtime.inspectProtectedProfile({ profile }); } catch { return null; }
        }))
          .then((actual) => ({ key: cacheKey, observedAt: this.#clock(), readiness: actual.map((item, index) => {
            const expected = identities.find((i) => i.workerId === profiles[index].workerId);
            const exact = expected && item && valid.has(profiles[index].workerId)
              && IDENTITY_FIELDS.slice(0, 6).every((key) => item[key] === expected[key])
              // The canonical repository normalizes away ephemeral Docker metadata.
              // Require fresh authenticated runtime metadata; compare it to storage
              // only when that storage version actually persists those fields.
              && /^[a-f0-9]{64}$/.test(item.containerId ?? "")
              && Number.isFinite(Date.parse(item.startedAt ?? ""))
              && ["containerId", "startedAt"].every((key) => expected[key] == null || item[key] === expected[key]);
            const healthy = exact && item.healthy === true && item.state === "running";
            const startupState = healthy ? "ready" : exact && ["loading", "retrying", "failed"].includes(item.startupState)
              ? item.startupState : "unavailable";
            return [profiles[index].workerId, { healthy: Boolean(healthy), startupState }];
          }) }));
        this.#pending = { key: cacheKey, promise };
      }
      const pending = this.#pending;
      inspection = await pending.promise;
      this.#inspection = inspection;
      if (this.#pending === pending) this.#pending = null;
    }
    // A maintenance/recovery transition that raced the health reads wins.
    const after = await this.#state();
    const afterAge = this.#clock() - new Date(after?.last_seen_at).getTime();
    return afterAge >= 0 && afterAge < 120_000 && isDeepStrictEqual(stableState(state), stableState(after))
      ? new Map(inspection.readiness) : new Map();
  }

  async snapshot() {
    const [base, state, result, startup] = await Promise.all([this.#repository.snapshot(), this.#state(),
      this.#database.query(`SELECT profile.id,profile.profile_key,profile.certification_state,
        profile.placement_class,capability.capability_key
        FROM compute.model_profiles profile
        JOIN compute.capabilities capability ON capability.id=profile.capability_id
        WHERE profile.id=ANY($1::uuid[]) AND capability.lifecycle_state='active'
        ORDER BY profile.id`, [this.#profiles.map((p) => p.profileId)]),
      Promise.resolve().then(() => this.#runtime.inspectStartupStates?.()).catch(() => null),
    ]);
    const readiness = await this.#readiness(state, result.rows);
    const overrides = new Map(this.#profiles.map((expected) => {
      const prior = base.capabilities.find((c) => c.capabilityKey === expected.capabilityKey) ?? {};
      const { healthy = false, startupState: inspectedState = "unavailable" } = readiness.get(expected.workerId) ?? {};
      const progress = startup?.get(expected.workerId);
      const startupState = !healthy && inspectedState === "unavailable" && ["loading", "retrying", "failed"].includes(progress)
        ? progress : inspectedState;
      const certified = result.rows.find((p) => p.id === expected.profileId)?.certification_state === "certified";
      const selected = healthy ? [expected.profileKey] : [];
      return [expected.capabilityKey, Object.freeze({ ...prior, capabilityKey: expected.capabilityKey,
        startupState,
        protectedDefault: expected.profileKey, selectedProfile: healthy ? expected.profileKey : null,
        selectedProfileId: healthy ? expected.profileId : null,
        selectedCertificationState: healthy ? (certified ? "certified" : "validating") : null,
        eligible: healthy, certified: healthy && certified,
        experimental: healthy && !certified, localRoute: healthy,
        providerRoute: false,
        localRoutableProfiles: selected, localActuallyRoutableProfiles: selected,
        providerRoutableProfiles: [],
        providerActuallyRoutableProfiles: [],
        certifiedProfiles: certified ? selected : [],
        experimentalProfiles: !certified ? selected : [],
      })];
    }));
    return Object.freeze({ ...base, capabilities: Object.freeze([
      ...base.capabilities.filter((c) => !overrides.has(c.capabilityKey)), ...overrides.values(),
    ]) });
  }

  getApplication(pluginKey) {
    return this.#repository.getApplication(pluginKey);
  }
}
