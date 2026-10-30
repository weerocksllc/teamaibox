function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function date(value) { return value == null ? null : new Date(value); }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

function mapping(row) {
  return {
    modelProfileId: row.model_profile_id,
    providerModelName: row.provider_model_name,
    operations: json(row.operations),
    contextWindow: Number(row.context_window),
    maximumOutputTokens: row.maximum_output_tokens == null ? null : Number(row.maximum_output_tokens),
    routingWeight: Number(row.routing_weight),
    enabled: row.enabled === true,
  };
}

function provider(row, modelMappings) {
  if (!row) return null;
  const trust = json(row.trust_policy), rateLimits = json(row.rate_limits);
  const configuration = row.configuration == null ? {} : json(row.configuration);
  return {
    providerId: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    providerKind: row.provider_kind,
    dataPolicy: row.data_policy,
    endpoint: row.endpoint_uri,
    lifecycleState: row.lifecycle_state,
    auth: { scheme: row.auth_scheme, headerName: row.auth_header_name },
    credentialSecretKey: row.secret_ref,
    trust: { mode: trust.mode, serverName: trust.serverName ?? null },
    caSecretKey: row.ca_secret_ref,
    allowedDataClasses: json(row.allowed_data_classes),
    limits: { concurrency: Number(row.concurrency_limit), requestsPerMinute: Number(rateLimits.requestsPerMinute), tokensPerMinute: rateLimits.tokensPerMinute == null ? null : Number(rateLimits.tokensPerMinute) },
    timeouts: json(row.timeout_policy),
    executionContract: row.execution_contract == null ? {
      idempotencyMode: "none", replayAfterAcceptance: "prohibited", reconcileMode: "none",
      cancellationMode: "none", sideEffectClass: "none", idempotencyHeader: null,
      statusPathTemplate: null, cancelPathTemplate: null, cancelMethod: null,
    } : json(row.execution_contract),
    resourceControl: configuration.resourceControl ?? null,
    healthCheck: json(row.health_check),
    health: { ...json(row.health), observedAt: json(row.health).observedAt == null ? null : new Date(json(row.health).observedAt) },
    costAccounting: json(row.cost_accounting),
    contract: { state: row.contract_state, evidenceDigest: digest(row.contract_evidence_digest), testedAt: date(row.contract_tested_at), failedChecks: json(row.contract_failed_checks) },
    modelMappings,
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

async function selectOne(executor, clause, parameters, lock = false) {
  const row = rows(await executor.query(`SELECT * FROM compute.providers WHERE ${clause}${lock ? " FOR UPDATE" : ""}`, parameters))[0];
  if (!row) return null;
  const mappings = rows(await executor.query(`
    SELECT * FROM compute.provider_model_profiles
    WHERE provider_id = $1 ORDER BY model_profile_id`, [row.id])).map(mapping);
  return provider(row, mappings);
}

export class PostgresExternalProviderRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required"); this.#database = database; }
  async list() {
    const providers = rows(await this.#database.query(`SELECT * FROM compute.providers WHERE provider_kind='external_openai' AND lifecycle_state<>'removed' ORDER BY provider_key`));
    const result = [];
    for (const row of providers) {
      const mappings = rows(await this.#database.query(`SELECT * FROM compute.provider_model_profiles WHERE provider_id=$1 ORDER BY model_profile_id`, [row.id])).map(mapping);
      result.push(provider(row, mappings));
    }
    return result;
  }
  async listRoutable() {
    const providers = rows(await this.#database.query(`
      SELECT * FROM compute.providers
      WHERE provider_kind='external_openai'
        AND lifecycle_state<>'removed'
      ORDER BY provider_kind, provider_key`));
    const result = [];
    for (const row of providers) {
      const mappings = rows(await this.#database.query(`SELECT * FROM compute.provider_model_profiles WHERE provider_id=$1 ORDER BY model_profile_id`, [row.id])).map(mapping);
      result.push(provider(row, mappings));
    }
    return result;
  }
  async findById(id) { return selectOne(this.#database, "id=$1 AND provider_kind='external_openai'", [id]); }
  async findByKey(key) { return selectOne(this.#database, "provider_key=$1 AND provider_kind='external_openai'", [key]); }

  async create(value) {
    return this.#database.transaction(async (transaction) => {
      const duplicate = rows(await transaction.query(`SELECT id FROM compute.providers WHERE provider_key=$1 FOR UPDATE`, [value.providerKey]))[0];
      if (duplicate) conflict("provider_key_conflict", "Provider key already exists");
      const profileIds = value.modelMappings.map((item) => item.modelProfileId);
      const profiles = rows(await transaction.query(`SELECT id FROM compute.model_profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, [profileIds]));
      if (profiles.length !== profileIds.length) conflict("provider_model_profile_missing", "One or more logical model profiles do not exist");
      await transaction.query(`
        INSERT INTO compute.providers (
          id, provider_key, display_name, provider_kind, endpoint_uri,
          secret_ref, auth_scheme, auth_header_name, ca_secret_ref, trust_policy,
          data_policy, allowed_data_classes, concurrency_limit, rate_limits,
          timeout_policy, execution_contract, health_check, health, cost_accounting, lifecycle_state,
          contract_state, contract_failed_checks, revision, created_by,
          created_at, updated_at, configuration
        ) VALUES (
          $1,$2,$3,'external_openai',$4,$5,$6,$7,$8,$9::jsonb,
          'approved_external',$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
          $16::jsonb,$17::jsonb,$18,'untested','[]'::jsonb,1,$19,$20,$20,$21::jsonb
        )`, [
        value.providerId, value.providerKey, value.displayName, value.endpoint,
        value.credentialSecretKey, value.auth.scheme, value.auth.headerName,
        value.caSecretKey, JSON.stringify(value.trust), JSON.stringify(value.allowedDataClasses),
        value.limits.concurrency, JSON.stringify({ requestsPerMinute: value.limits.requestsPerMinute, tokensPerMinute: value.limits.tokensPerMinute }),
        JSON.stringify(value.timeouts), JSON.stringify(value.executionContract), JSON.stringify(value.healthCheck), JSON.stringify(value.health),
        JSON.stringify(value.costAccounting), value.lifecycleState, value.createdBy, value.createdAt,
        JSON.stringify({ resourceControl: value.resourceControl ?? null }),
      ]);
      for (const item of value.modelMappings) {
        await transaction.query(`
          INSERT INTO compute.provider_model_profiles (
            provider_id, model_profile_id, provider_model_name, enabled,
            routing_weight, operations, context_window, maximum_output_tokens,
            limits, contract_state
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'{}'::jsonb,'untested')`, [
          value.providerId, item.modelProfileId, item.providerModelName, item.enabled,
          item.routingWeight, JSON.stringify(item.operations), item.contextWindow,
          item.maximumOutputTokens,
        ]);
      }
      return selectOne(transaction, "id=$1", [value.providerId]);
    });
  }

  async setLifecycle(id, revision, lifecycleState, updatedAt) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectOne(transaction, "id=$1 AND provider_kind='external_openai'", [id], true);
      if (!current) return null;
      if (current.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed");
      await transaction.query(`UPDATE compute.providers SET lifecycle_state=$2, revision=revision+1, updated_at=$3 WHERE id=$1`, [id, lifecycleState, updatedAt]);
      return selectOne(transaction, "id=$1", [id]);
    });
  }

  async recordContractTest(id, revision, observation) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectOne(transaction, "id=$1 AND provider_kind='external_openai'", [id], true);
      if (!current) return null;
      if (current.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed");
      const nextRevision = revision + 1;
      await transaction.query(`
        INSERT INTO compute.provider_contract_test_runs (
          id, provider_id, provider_revision, status, evidence_digest,
          failed_checks, observed_at, actor_identity_id
        ) VALUES (uuidv7(),$1,$2,$3,decode(substring($4 from 8),'hex'),$5::jsonb,$6,$7)`, [
        id, nextRevision, observation.contract.state, observation.contract.evidenceDigest,
        JSON.stringify(observation.contract.failedChecks), observation.contract.testedAt,
        observation.actorIdentityId,
      ]);
      await transaction.query(`
        INSERT INTO compute.provider_health_events (
          provider_id, provider_revision, state, latency_milliseconds,
          error_code, observed_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id, nextRevision, observation.health.state, observation.health.latencyMilliseconds,
        observation.health.errorCode, observation.health.observedAt,
      ]);
      await transaction.query(`
        UPDATE compute.providers
        SET lifecycle_state=$2, health=$3::jsonb, contract_state=$4,
            contract_evidence_digest=decode(substring($5 from 8),'hex'),
            contract_tested_at=$6, contract_failed_checks=$7::jsonb,
            revision=revision+1, updated_at=$8
        WHERE id=$1`, [
        id, observation.lifecycleState, JSON.stringify(observation.health),
        observation.contract.state, observation.contract.evidenceDigest,
        observation.contract.testedAt, JSON.stringify(observation.contract.failedChecks),
        observation.updatedAt,
      ]);
      await transaction.query(`UPDATE compute.provider_model_profiles SET contract_state=$2 WHERE provider_id=$1`, [id, observation.contract.state]);
      return selectOne(transaction, "id=$1", [id]);
    });
  }

  async recordHealth(id, observation) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectOne(transaction, "id=$1 AND provider_kind='external_openai'", [id], true);
      if (!current || current.lifecycleState === "removed") return null;
      await transaction.query(`
        INSERT INTO compute.provider_health_events (
          provider_id, provider_revision, state, latency_milliseconds,
          error_code, observed_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id, current.revision, observation.health.state, observation.health.latencyMilliseconds,
        observation.health.errorCode, observation.health.observedAt,
      ]);
      await transaction.query(`
        UPDATE compute.providers
        SET lifecycle_state=$2, health=$3::jsonb
        WHERE id=$1`, [id, observation.lifecycleState, JSON.stringify(observation.health)]);
      return selectOne(transaction, "id=$1", [id]);
    });
  }

  async remove(id, revision, updatedAt) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectOne(transaction, "id=$1 AND provider_kind='external_openai'", [id], true);
      if (!current) return null;
      if (current.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed");
      await transaction.query(`UPDATE compute.providers SET lifecycle_state='removed', revision=revision+1, updated_at=$2 WHERE id=$1`, [id, updatedAt]);
      return selectOne(transaction, "id=$1", [id]);
    });
  }
}
