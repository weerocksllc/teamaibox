function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL application catalog result is invalid");
  return result.rows;
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function date(value) {
  return value == null ? null : new Date(value).toISOString();
}

export class PostgresApplicationCatalogRepository {
  #database;
  #policyKey;
  #environment;
  #localNodeId;

  constructor({ database, routingPolicyKey = "production.default", environment = "production", localNodeId = null }) {
    if (!database?.query) throw new TypeError("PostgreSQL database adapter is required");
    if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(routingPolicyKey)
        || !new Set(["production", "development", "validation"]).has(environment)) {
      throw new TypeError("Application catalog model routing policy is invalid");
    }
    this.#database = database;
    this.#policyKey = routingPolicyKey;
    this.#environment = environment;
    if (localNodeId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localNodeId)) throw new TypeError("Local application health node is invalid");
    this.#localNodeId = localNodeId;
  }

  async snapshot() {
    const [pluginResult, capabilityResult, healthResult] = await Promise.all([
      this.#database.query(`
        SELECT plugin.plugin_key, plugin.plugin_type, plugin.lifecycle_state,
               current.version AS current_version, current.manifest,
               current.install_state, plugin.active_slot,
               slot.slot_state, slot.health AS slot_health, slot.updated_at AS slot_updated_at
        FROM plugins.plugins plugin
        LEFT JOIN plugins.plugin_versions current ON current.id=plugin.current_version_id
        LEFT JOIN plugins.runtime_slots slot
          ON slot.plugin_id=plugin.id AND slot.slot=plugin.active_slot
        ORDER BY plugin.plugin_key`),
      this.#database.query(`
        WITH routes AS (
          SELECT capability.id AS capability_id, profile.id AS profile_id, profile.profile_key,
                 profile.certification_state AS certification_state,
                 NULL::uuid AS binding_id, profile.profile_key AS route_key
          FROM compute.capabilities capability
          JOIN compute.model_profiles profile ON profile.capability_id=capability.id
          UNION ALL
          SELECT binding.capability_id, profile.id, profile.profile_key,
                 CASE binding.lifecycle_state WHEN 'certified' THEN 'certified' ELSE 'experimental' END,
                 binding.id, binding.binding_key
          FROM compute.model_capability_bindings binding
          JOIN compute.model_profiles profile ON profile.id=binding.model_profile_id
          WHERE binding.lifecycle_state<>'disabled'
        ), selected_routes AS (
          SELECT DISTINCT ON (binding.capability_id)
                 binding.capability_id, profile.profile_key,
                 profile.certification_state
          FROM compute.node_capabilities binding
          JOIN compute.nodes node ON node.id=binding.node_id
          JOIN compute.model_profiles profile
            ON profile.id::text=binding.evidence->>'profileId'
          WHERE binding.availability_state IN ('available','degraded')
            AND node.lifecycle_state='ready'
          ORDER BY binding.capability_id,binding.observed_at DESC,profile.profile_key
        )
        SELECT capability.capability_key,
               bool_or(route.certification_state='certified') AS certified,
               bool_or(route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL) AS eligible,
               bool_or(opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL) AS experimental,
               bool_or((route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND (worker.lifecycle_state='stopped' OR (
                   worker.lifecycle_state IN ('starting','preparing','ready','busy')
                   AND worker.health_state IN ('starting','healthy')
                   AND worker.health_observed_at >= clock_timestamp()-interval '120 seconds'
                   AND (worker.lifecycle_state IN ('starting','preparing') OR worker.last_heartbeat_at >= clock_timestamp()-interval '120 seconds')
                 ))
                 AND node.lifecycle_state='ready'
                 AND node.last_seen_at >= clock_timestamp()-interval '120 seconds') AS local_route,
               bool_or((route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND mapping.enabled AND mapping.contract_state='passed'
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(mapping.operations) operation
                   WHERE capability.api_operations ? operation
                     OR (capability.capability_key='translation' AND operation='chat.completions'))
                 AND provider.contract_state='passed'
                 AND provider.lifecycle_state IN ('healthy','degraded')
                 AND NULLIF(provider.health->>'observedAt','')::timestamptz >= clock_timestamp()-interval '120 seconds') AS provider_route,
               array_remove(array_agg(DISTINCT CASE WHEN
                 (route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND (worker.lifecycle_state='stopped' OR (
                   worker.lifecycle_state IN ('starting','preparing','ready','busy')
                   AND worker.health_state IN ('starting','healthy')
                   AND worker.health_observed_at >= clock_timestamp()-interval '120 seconds'
                   AND (worker.lifecycle_state IN ('starting','preparing') OR worker.last_heartbeat_at >= clock_timestamp()-interval '120 seconds')
                 )) AND node.lifecycle_state='ready'
                 AND node.last_seen_at >= clock_timestamp()-interval '120 seconds'
                 THEN route.route_key ELSE NULL END), NULL) AS local_routable_profiles,
               array_remove(array_agg(DISTINCT CASE WHEN
                 (route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND mapping.enabled AND mapping.contract_state='passed'
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(mapping.operations) operation
                   WHERE capability.api_operations ? operation
                     OR (capability.capability_key='translation' AND operation='chat.completions'))
                 AND provider.contract_state='passed' AND provider.lifecycle_state IN ('healthy','degraded')
                 AND NULLIF(provider.health->>'observedAt','')::timestamptz >= clock_timestamp()-interval '120 seconds'
                 THEN route.route_key ELSE NULL END), NULL) AS provider_routable_profiles,
               array_remove(array_agg(DISTINCT CASE WHEN
                 (route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND worker.lifecycle_state IN ('ready','busy')
                 AND worker.health_state='healthy'
                 AND worker.health_observed_at >= clock_timestamp()-interval '120 seconds'
                 AND worker.last_heartbeat_at >= clock_timestamp()-interval '120 seconds'
                 AND node.lifecycle_state='ready'
                 AND node.last_seen_at >= clock_timestamp()-interval '120 seconds'
                 THEN route.route_key ELSE NULL END), NULL) AS local_actually_routable_profiles,
               array_remove(array_agg(DISTINCT CASE WHEN
                 (route.certification_state='certified' OR opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL)
                 AND mapping.enabled AND mapping.contract_state='passed'
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(mapping.operations) operation
                   WHERE capability.api_operations ? operation
                     OR (capability.capability_key='translation' AND operation='chat.completions'))
                 AND provider.contract_state='passed'
                 AND provider.lifecycle_state='healthy'
                 AND provider.health->>'state'='healthy'
                 AND NULLIF(provider.health->>'observedAt','')::timestamptz >= clock_timestamp()-interval '120 seconds'
                 AND (
                   provider.configuration->'resourceControl' IS NULL
                   OR (
                     provider.health->>'status'='ready'
                     AND provider.health->>'loaded'='true'
                     AND provider.health->>'model'=mapping.provider_model_name
                   )
                 )
                 THEN route.route_key ELSE NULL END), NULL) AS provider_actually_routable_profiles,
               selected.profile_key AS selected_profile,
               selected.certification_state AS selected_certification_state,
               array_remove(array_agg(DISTINCT CASE
                 WHEN route.certification_state='certified' THEN route.route_key
                 ELSE NULL END ORDER BY CASE
                 WHEN route.certification_state='certified' THEN route.route_key
                 ELSE NULL END), NULL) AS certified_profiles
               ,array_remove(array_agg(DISTINCT CASE
                 WHEN opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL THEN route.route_key
                 ELSE NULL END ORDER BY CASE
                 WHEN opt_in.id IS NOT NULL OR binding_opt_in.id IS NOT NULL THEN route.route_key
                 ELSE NULL END), NULL) AS experimental_profiles
        FROM compute.capabilities capability
        LEFT JOIN routes route ON route.capability_id=capability.id
        LEFT JOIN selected_routes selected ON selected.capability_id=capability.id
        LEFT JOIN compute.worker_instances worker ON worker.model_profile_id=route.profile_id
        LEFT JOIN compute.nodes node ON node.id=worker.node_id
        LEFT JOIN compute.model_experimental_routing_opt_ins opt_in
          ON route.binding_id IS NULL AND opt_in.model_profile_id=route.profile_id AND opt_in.policy_key=$1
          AND opt_in.environment=$2 AND opt_in.enabled AND opt_in.expires_at>clock_timestamp()
        LEFT JOIN compute.model_capability_binding_opt_ins binding_opt_in
          ON binding_opt_in.binding_id=route.binding_id AND binding_opt_in.policy_key=$1
          AND binding_opt_in.environment=$2 AND binding_opt_in.enabled AND binding_opt_in.expires_at>clock_timestamp()
        LEFT JOIN compute.provider_model_profiles mapping ON mapping.model_profile_id=route.profile_id
        LEFT JOIN compute.providers provider ON provider.id=mapping.provider_id AND provider.provider_kind='external_openai'
        WHERE capability.lifecycle_state='active'
        GROUP BY capability.id, capability.capability_key,
                 selected.profile_key,selected.certification_state
        ORDER BY capability.capability_key`, [this.#policyKey, this.#environment]),
      this.#database.query(`
        SELECT DISTINCT ON (target_kind,target_key)
               target_kind,target_key,health_state,reason_code,observed_at
        FROM (SELECT id,target_kind,
          CASE WHEN target_kind='core_service' AND $1::text IS NOT NULL
            THEN substring(target_key FROM length($1::text)+2) ELSE target_key END AS target_key,
          health_state,reason_code,observed_at
          FROM platform.health_signals
          WHERE $1::text IS NULL OR target_kind<>'core_service'
            OR starts_with(target_key,$1::text || '/')) local_health
        WHERE observed_at >= statement_timestamp()-interval '120 seconds'
          AND target_kind IN ('core_service','plugin')
        ORDER BY target_kind,target_key,observed_at DESC,id DESC`, [this.#localNodeId]),
    ]);

    return Object.freeze({
      plugins: Object.freeze(rows(pluginResult).map((row) => Object.freeze({
        pluginKey: row.plugin_key,
        pluginType: row.plugin_type,
        lifecycleState: row.lifecycle_state,
        currentVersion: row.current_version,
        manifest: json(row.manifest),
        installState: row.install_state,
        activeSlot: row.active_slot,
        slotState: row.slot_state,
        slotHealth: json(row.slot_health),
        slotUpdatedAt: date(row.slot_updated_at),
      }))),
      capabilities: Object.freeze(rows(capabilityResult).map((row) => Object.freeze({
        capabilityKey: row.capability_key,
        certified: row.certified === true,
        eligible: row.eligible === true,
        experimental: row.experimental === true,
        selectedProfile: row.selected_profile ?? null,
        selectedCertificationState: row.selected_certification_state ?? null,
        localRoute: row.local_route === true,
        providerRoute: row.provider_route === true,
        localRoutableProfiles: Object.freeze([...(row.local_routable_profiles ?? [])]),
        providerRoutableProfiles: Object.freeze([...(row.provider_routable_profiles ?? [])]),
        localActuallyRoutableProfiles: Object.freeze([...(row.local_actually_routable_profiles ?? [])]),
        providerActuallyRoutableProfiles: Object.freeze([...(row.provider_actually_routable_profiles ?? [])]),
        certifiedProfiles: Object.freeze([...(row.certified_profiles ?? [])]),
        experimentalProfiles: Object.freeze([...(row.experimental_profiles ?? [])]),
      }))),
      health: Object.freeze(rows(healthResult).map((row) => Object.freeze({
        targetKind: row.target_kind,
        targetKey: row.target_key,
        state: row.health_state,
        reasonCode: row.reason_code,
        observedAt: date(row.observed_at),
      }))),
    });
  }

  // Static application assets need current installation and permission facts,
  // not the model/provider inventory used by the workbench availability cards.
  async getApplication(pluginKey) {
    const row = rows(await this.#database.query(`
      SELECT plugin.plugin_key, plugin.plugin_type, plugin.lifecycle_state,
             current.version AS current_version, current.manifest,
             current.install_state, plugin.active_slot,
             slot.slot_state, slot.health AS slot_health, slot.updated_at AS slot_updated_at
      FROM plugins.plugins plugin
      LEFT JOIN plugins.plugin_versions current ON current.id=plugin.current_version_id
      LEFT JOIN plugins.runtime_slots slot
        ON slot.plugin_id=plugin.id AND slot.slot=plugin.active_slot
      WHERE plugin.plugin_key=$1`, [pluginKey]))[0];
    return row ? Object.freeze({
      pluginKey: row.plugin_key, pluginType: row.plugin_type, lifecycleState: row.lifecycle_state,
      currentVersion: row.current_version, manifest: json(row.manifest), installState: row.install_state,
      activeSlot: row.active_slot, slotState: row.slot_state, slotHealth: json(row.slot_health),
      slotUpdatedAt: date(row.slot_updated_at),
    }) : null;
  }
}
