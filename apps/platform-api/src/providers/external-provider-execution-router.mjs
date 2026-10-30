import { NodeHttpsProviderTransport } from "../../../../services/scheduler/src/external-provider-contract-tester.mjs";

const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const ROUTE_OPERATIONS = new Set(["responses", "chat.completions", "embeddings", "images.generations", "images.edits", "ocr", "transcriptions", "translations"]);
const PROVIDER_OPERATION = Object.freeze({
  transcriptions: "audio.transcriptions",
  translations: "chat.completions",
});
const PROVIDER_READER = Object.freeze({
  service: "provider-adapter",
  permissions: Object.freeze(["secrets:read"]),
});

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("External provider route query result is invalid");
  return result.rows;
}

function profileDocument(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function localOnly(request) {
  return request?.x_teamaibox?.extensions?.routing?.localOnly === true
    || request?.x_teamaibox?.extensions?.routing?.local_only === true;
}

function fresh(provider, now) {
  const observedAt = provider.health?.observedAt ? new Date(provider.health.observedAt) : null;
  const maximumAge = Math.max(15_000, Math.min(120_000, (provider.healthCheck?.intervalSeconds ?? 30) * 3_000));
  return observedAt !== null && Number.isFinite(observedAt.getTime())
    && now.getTime() - observedAt.getTime() <= maximumAge;
}

function profileAllowsExternal(document, dataClass, approved) {
  const policy = document?.dataPolicy ?? document?.data_policy ?? null;
  if (!policy) return approved;
  const allowed = policy.allowedDataClasses ?? policy.allowed_data_classes;
  if (Array.isArray(allowed) && !allowed.includes(dataClass)) return false;
  const external = policy.externalProcessing ?? policy.external_processing;
  if (external === "forbidden") return false;
  if (external === "approved_only" && approved !== true) return false;
  return true;
}

function drawingRouteAuthorized({ job }) {
  if (!new Set(["images.generations", "images.edits"]).has(job.operation)) return true;
  // Built-in drawing intents are local. Optional external providers are
  // explicit external requests, not a route to a former auxiliary box.
  return !(typeof job.model === 'string' && job.model.startsWith('drawing.')) && job.profileId == null;
}

function selectProvider({ policy, providers, localAvailable }) {
  if (providers.length === 0) return null;
  if (policy.mode === "pinned") {
    const selected = providers.find((entry) => (!policy.pinnedTargetId || entry.provider.providerId === policy.pinnedTargetId)
      && (!policy.pinnedProfileId || entry.mapping.modelProfileId === policy.pinnedProfileId));
    return selected ?? null;
  }
  if (policy.mode === "internal_only") return null;
  if (policy.mode === "internal_first") return localAvailable ? null : providers[0] ?? null;
  if (policy.mode === "external_first") return providers[0] ?? null;
  if (policy.mode === "weighted") {
    const localWeight = Number(policy.targetWeights?.["spark-local"] ?? 100);
    const selected = providers[0];
    const providerWeight = Number(policy.targetWeights?.[selected.provider.providerId] ?? selected.mapping.routingWeight);
    return !localAvailable || providerWeight > localWeight ? selected : null;
  }
  return providers[0];
}

export class ExternalProviderExecutionRouter {
  #database;
  #providers;
  #policies;
  #secrets;
  #transport;
  #clock;
  #audit;
  #policyKey;
  #environment;
  #residency = new Map();
  #schedule;
  #cancelSchedule;

  constructor({
    database,
    providerRepository,
    routingPolicyRegistry,
    secretStore,
    transport = new NodeHttpsProviderTransport(),
    clock = () => new Date(),
    audit = async () => {},
    modelRoutingPolicyKey = "production.default",
    modelRoutingEnvironment = "production",
    schedule = (operation, milliseconds) => setTimeout(operation, milliseconds),
    cancelSchedule = (timer) => clearTimeout(timer),
  }) {
    if (!database?.query || !providerRepository?.list || !routingPolicyRegistry?.resolve
        || !secretStore?.withSecret || !transport?.request || !transport?.stream
        || typeof clock !== "function" || typeof audit !== "function"
        || typeof schedule !== "function" || typeof cancelSchedule !== "function"
        || !/^[a-z][a-z0-9_.-]{2,127}$/.test(modelRoutingPolicyKey)
        || !new Set(["production", "development", "validation"]).has(modelRoutingEnvironment)) {
      throw new TypeError("External provider execution router dependencies are incomplete");
    }
    this.#database = database;
    this.#providers = providerRepository;
    this.#policies = routingPolicyRegistry;
    this.#secrets = secretStore;
    this.#transport = transport;
    this.#clock = clock;
    this.#audit = audit;
    this.#policyKey = modelRoutingPolicyKey;
    this.#environment = modelRoutingEnvironment;
    this.#schedule = schedule;
    this.#cancelSchedule = cancelSchedule;
  }

  async #eligibleProfiles(job) {
    const result = await this.#database.query(`
      WITH routes AS (
        SELECT profile.id AS profile_id, profile.capability_id,
               profile.certification_state, NULL::uuid AS binding_id
        FROM compute.model_profiles profile
        UNION ALL
        SELECT profile.id, binding.capability_id,
               CASE binding.lifecycle_state WHEN 'certified' THEN 'certified' ELSE 'experimental' END,
               binding.id
        FROM compute.model_capability_bindings binding
        JOIN compute.model_profiles profile ON profile.id=binding.model_profile_id
        WHERE binding.lifecycle_state<>'disabled'
      )
      SELECT DISTINCT route.profile_id, registration.profile_fingerprint, registration.profile_document
      FROM routes route
      LEFT JOIN compute.model_profile_registrations registration
        ON registration.profile_id=route.profile_id
      LEFT JOIN compute.model_experimental_routing_opt_ins profile_opt_in
        ON route.binding_id IS NULL AND profile_opt_in.model_profile_id=route.profile_id
       AND profile_opt_in.policy_key=$2 AND profile_opt_in.environment=$3
       AND profile_opt_in.enabled AND profile_opt_in.expires_at>clock_timestamp()
      LEFT JOIN compute.model_capability_binding_opt_ins binding_opt_in
        ON binding_opt_in.binding_id=route.binding_id
       AND binding_opt_in.policy_key=$2 AND binding_opt_in.environment=$3
       AND binding_opt_in.enabled AND binding_opt_in.expires_at>clock_timestamp()
      WHERE route.capability_id=$1
        AND (route.certification_state='certified' OR profile_opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
      ORDER BY route.profile_id`, [job.capabilityId, this.#policyKey, this.#environment]);
    return rows(result).map((row) => ({
      profileId: row.profile_id,
      fingerprint: row.profile_fingerprint == null ? null
        : `sha256:${Buffer.from(row.profile_fingerprint).toString("hex")}`,
      document: profileDocument(row.profile_document),
    }));
  }

  async resolve({ job, request, localAvailable }) {
    if (!job?.capabilityId || !ROUTE_OPERATIONS.has(job.operation)
        || !DATA_CLASSES.has(job.dataClass) || typeof localAvailable !== "boolean") {
      throw new TypeError("External provider execution route facts are invalid");
    }
    const policy = await this.#policies.resolve({
      capabilityId: job.capabilityId,
      operation: job.operation,
      teamId: null,
      dataClass: job.dataClass,
    });
    const eligibleProfiles = await this.#eligibleProfiles(job);
    const profiles = new Map(eligibleProfiles.map((entry) => [entry.profileId, entry]));
    const now = this.#clock();
    const candidates = [];
    const providers = this.#providers.listRoutable
      ? await this.#providers.listRoutable()
      : await this.#providers.list();
    for (const provider of providers) {
      if (provider.providerKind !== 'external_openai' || provider.lifecycleState !== "healthy" || provider.contract?.state !== "passed"
          || provider.health?.state !== "healthy" || !fresh(provider, now)
          || !provider.allowedDataClasses.includes(job.dataClass)) continue;
      for (const mapping of provider.modelMappings) {
        const profile = profiles.get(mapping.modelProfileId);
        const providerOperation = PROVIDER_OPERATION[job.operation] ?? job.operation;
        const routeKind = 'external_provider';
        const policyAllowsRoute = policy.allowExternal === true && policy.externalProcessingApproved === true
            && !localOnly(request)
            && profileAllowsExternal(profile?.document, job.dataClass, policy.externalProcessingApproved);
        if (!profile || mapping.enabled !== true || !mapping.operations.includes(providerOperation)
            || (job.profileId && mapping.modelProfileId !== job.profileId)
            || !drawingRouteAuthorized({ profile, mapping, routeKind, job, request })
            || !policyAllowsRoute) continue;
        candidates.push({ provider, mapping, profile, routeKind });
      }
    }
    candidates.sort((left, right) => {
      const leftWeight = Number(policy.targetWeights?.[left.provider.providerId] ?? left.mapping.routingWeight);
      const rightWeight = Number(policy.targetWeights?.[right.provider.providerId] ?? right.mapping.routingWeight);
      return rightWeight - leftWeight
        || left.provider.providerKey.localeCompare(right.provider.providerKey)
        || left.mapping.modelProfileId.localeCompare(right.mapping.modelProfileId);
    });
    const selected = selectProvider({ policy, providers: candidates, localAvailable });
    if (!selected) {
      const denied = localOnly(request);
      return Object.freeze({ selected: null, policy, reasonCode: denied ? "routing.local_only"
        : localAvailable ? "routing.internal_selected" : "routing.no_external_target" });
    }
    await this.#audit({
      action: "compute.external_route_selected",
      jobId: job.jobId,
      ownerIdentityId: job.ownerIdentityId,
      providerId: selected.provider.providerId,
      modelProfileId: selected.mapping.modelProfileId,
      operation: job.operation,
      policyId: policy.policyId,
      policyRevision: policy.policyRevision,
      occurredAt: now.toISOString(),
    });
    return Object.freeze({
      selected: Object.freeze({
        provider: selected.provider,
        mapping: selected.mapping,
        profile: selected.profile,
        routeKind: selected.routeKind,
      }),
      policy,
      reasonCode: `routing.${policy.mode}.${selected.routeKind}_selected`,
    });
  }

  async resolveCapability({ parentJob, capabilityKey, operation, request, localAvailable }) {
    if (!parentJob?.jobId || !parentJob?.ownerIdentityId || !DATA_CLASSES.has(parentJob.dataClass)
        || typeof capabilityKey !== "string" || !/^[a-z][a-z0-9_.-]{1,127}$/.test(capabilityKey)
        || !ROUTE_OPERATIONS.has(operation) || typeof localAvailable !== "boolean") {
      throw new TypeError("Composed external provider route facts are invalid");
    }
    const result = await this.#database.query(
      "SELECT id FROM compute.capabilities WHERE capability_key=$1",
      [capabilityKey],
    );
    const capability = rows(result);
    if (capability.length !== 1 || typeof capability[0]?.id !== "string") {
      return Object.freeze({ selected: null, policy: null, reasonCode: "routing.capability_unavailable" });
    }
    return this.resolve({
      job: {
        jobId: parentJob.jobId,
        ownerIdentityId: parentJob.ownerIdentityId,
        capabilityId: capability[0].id,
        operation,
        profileId: null,
        dataClass: parentJob.dataClass,
      },
      request,
      localAvailable,
    });
  }

  #withSecrets(provider, callback) {
    const withCa = (credential) => provider.caSecretKey
      ? this.#secrets.withSecret(provider.caSecretKey, PROVIDER_READER, (customCa) => callback(credential, customCa))
      : callback(credential, null);
    return provider.credentialSecretKey
      ? this.#secrets.withSecret(provider.credentialSecretKey, PROVIDER_READER, (credential) => withCa(credential))
      : withCa(null);
  }

  request(route, input) {
    return this.#withSecrets(route.provider, (credential, customCa) => this.#transport.request({
      provider: route.provider,
      credential,
      customCa,
      ...input,
    }));
  }

  stream(route, input) {
    return this.#withSecrets(route.provider, (credential, customCa) => this.#transport.stream({
      provider: route.provider,
      credential,
      customCa,
      ...input,
    }));
  }

  async probe(route, signal) {
    try {
      const response = await this.request(route, {
        method: "GET",
        path: route.provider.healthCheck.path,
        timeoutMilliseconds: Math.min(5_000, route.provider.healthCheck.timeoutMilliseconds),
        signal,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  #residencyKey(route) {
    return `${route.provider.providerId}:${route.mapping.modelProfileId}`;
  }

  async prepareModel(route, signal, context = null) {
    const control = route?.provider?.resourceControl;
    if (control == null) return Object.freeze({ controlled: false, loaded: null, warmReuse: null });
    if (route?.profile?.document?.exclusive === true) {
      const error = new Error('External providers cannot request exclusive control of appliance resources');
      error.code = 'provider_model_exclusive_unavailable';
      throw error;
    }
    if (control.mode !== "model_api" || typeof control.preparePath !== "string"
        || typeof control.unloadPath !== "string" || typeof control.statusPath !== "string"
        || !Number.isSafeInteger(control.idleSeconds) || control.idleSeconds < 1
        || control.idleSeconds > 86_400) {
      throw new TypeError("Provider model resource-control declaration is invalid");
    }
    const key = this.#residencyKey(route);
    let state = this.#residency.get(key);
    if (!state) {
      state = { active: 0, prepared: false, preparing: null, timer: null, route };
      this.#residency.set(key, state);
    }
    if (state.timer) {
      this.#cancelSchedule(state.timer);
      state.timer = null;
    }
    state.active += 1;
    try {
      state.preparing ??= (async () => {
        if (state.prepared) {
          const status = await this.request(route, {
            method: "GET",
            path: control.statusPath,
            timeoutMilliseconds: Math.min(5_000, route.provider.timeouts.requestMilliseconds),
            signal,
          });
          if (status.status >= 200 && status.status < 300
              && status.body?.status === "ready" && status.body?.loaded === true
              && status.body?.model === route.mapping.providerModelName) {
            return Object.freeze({ warmReuse: true });
          }
          state.prepared = false;
        }
        const response = await this.request(route, {
          method: "POST",
          path: control.preparePath,
          body: { model: route.mapping.providerModelName },
          timeoutMilliseconds: route.provider.timeouts.requestMilliseconds,
          signal,
        });
        if (response.status < 200 || response.status >= 300
            || response.body?.status !== "ready" || response.body?.loaded !== true
            || response.body?.model !== route.mapping.providerModelName) {
          const error = new Error("Provider did not prepare the selected model");
          error.code = "provider_model_prepare_failed";
          throw error;
        }
        state.prepared = true;
        await this.#audit({
          action: "compute.external_model_prepared",
          providerId: route.provider.providerId,
          modelProfileId: route.mapping.modelProfileId,
          occurredAt: this.#clock().toISOString(),
        });
        return Object.freeze({ warmReuse: false });
      })().finally(() => { state.preparing = null; });
      const prepared = await state.preparing;
      return Object.freeze({ controlled: true, loaded: true, warmReuse: prepared.warmReuse });
    } catch (error) {
      state.active = Math.max(0, state.active - 1);
      if (state.active === 0 && state.prepared) this.releaseModel(route);
      else if (state.active === 0) {
        this.#residency.delete(key);
      }
      throw error;
    }
  }

  releaseModel(route) {
    const control = route?.provider?.resourceControl;
    if (control == null) return Object.freeze({ controlled: false, scheduled: false });
    const key = this.#residencyKey(route);
    const state = this.#residency.get(key);
    if (!state) return Object.freeze({ controlled: true, scheduled: false });
    state.active = Math.max(0, state.active - 1);
    if (state.active !== 0 || state.timer) return Object.freeze({ controlled: true, scheduled: false });
    const unload = async () => {
      state.timer = null;
      if (state.active !== 0 || !state.prepared) return;
      try {
        const response = await this.request(state.route, {
          method: "POST", path: control.unloadPath, body: { model: state.route.mapping.providerModelName },
          timeoutMilliseconds: Math.min(120_000, state.route.provider.timeouts.requestMilliseconds),
        });
        if (response.status >= 200 && response.status < 300 && response.body?.status === "unloaded"
            && response.body?.loaded === false && response.body?.model === state.route.mapping.providerModelName) {
          state.prepared = false;
          await this.#audit({
            action: "compute.external_model_unloaded",
            providerId: state.route.provider.providerId,
            modelProfileId: state.route.mapping.modelProfileId,
            occurredAt: this.#clock().toISOString(),
          });
          if (state.active === 0) this.#residency.delete(key);
        }
      } catch {
        // The Provider's own idle policy remains the fail-safe. A subsequent
        // request probes and prepares again instead of assuming unload success.
      }
    };
    state.timer = this.#schedule(unload, control.idleSeconds * 1_000);
    state.timer?.unref?.();
    return Object.freeze({ controlled: true, scheduled: true, idleSeconds: control.idleSeconds });
  }

  close() {
    for (const state of this.#residency.values()) if (state.timer) this.#cancelSchedule(state.timer);
    this.#residency.clear();
  }
}
