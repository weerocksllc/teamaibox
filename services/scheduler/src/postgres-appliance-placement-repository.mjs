function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL appliance placement result is invalid");
  return result.rows;
}

function json(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function date(value) {
  return value == null ? null : new Date(value);
}

function digest(value) {
  return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`;
}

function node(row) {
  if (!row) return null;
  return {
    nodeId: row.id,
    applianceRole: row.appliance_role,
    desiredState: json(row.desired_state),
    desiredStateRevision: Number(row.desired_state_revision),
    observedStateRevision: Number(row.observed_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    recoveryState: row.recovery_state,
    recoveryReasonCode: row.recovery_reason_code,
  };
}

function profile(row) {
  if (!row) return null;
  return {
    modelProfileId: row.id,
    placementClass: row.placement_class,
    desiredStateRevision: Number(row.desired_state_revision),
    observedStateRevision: Number(row.observed_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    recoveryState: row.recovery_state,
    recoveryReasonCode: row.recovery_reason_code,
  };
}

function placementRevision(row, prefix = "") {
  const get = (name) => row[`${prefix}${name}`];
  if (!get("id")) return null;
  return {
    placementRevisionId: get("id"),
    modelProfileId: get("model_profile_id"),
    placementRevision: Number(get("placement_revision")),
    placementClass: get("placement_class"),
    desiredStateRevision: Number(get("desired_state_revision")),
    observedStateRevision: Number(get("observed_state_revision")),
    maintenanceGeneration: Number(get("maintenance_generation")),
    placementState: get("placement_state"),
    recoveryState: get("recovery_state"),
    recoveryReasonCode: get("recovery_reason_code"),
    configurationDigest: digest(get("configuration_digest")),
    resourceEnvelope: json(get("resource_envelope")),
    warmProbe: json(get("warm_probe")),
    evidenceRefs: json(get("evidence_refs")),
    previousRevisionId: get("previous_revision_id"),
    actorIdentityId: get("actor_identity_id"),
    occurredAt: date(get("occurred_at")),
  };
}

/** Read-only local placement facts. Existing profile revisions remain intact. */
export class PostgresAppliancePlacementRepository {
  #database; #localNodeId;
  constructor({database,localNodeId}) {
    if (!database?.query || !localNodeId) throw TypeError("Local appliance placement requires database and identity");
    this.#database=database; this.#localNodeId=localNodeId;
  }
  async listNodePlacements() {
    return rows(await this.#database.query("SELECT * FROM compute.nodes WHERE id=$1 AND appliance_role='appliance-core'",[this.#localNodeId]))
      .map(row=>({node:node(row)}));
  }
  async getModelProfilePlacement(modelProfileId) {
    const row = rows(await this.#database.query(`
      SELECT profile.*,
             revision.id AS current_id,
             revision.model_profile_id AS current_model_profile_id,
             revision.placement_revision AS current_placement_revision,
             revision.placement_class AS current_placement_class,
             revision.desired_state_revision AS current_desired_state_revision,
             revision.observed_state_revision AS current_observed_state_revision,
             revision.maintenance_generation AS current_maintenance_generation,
             revision.placement_state AS current_placement_state,
             revision.recovery_state AS current_recovery_state,
             revision.recovery_reason_code AS current_recovery_reason_code,
             revision.configuration_digest AS current_configuration_digest,
             revision.resource_envelope AS current_resource_envelope,
             revision.warm_probe AS current_warm_probe,
             revision.evidence_refs AS current_evidence_refs,
             revision.previous_revision_id AS current_previous_revision_id,
             revision.actor_identity_id AS current_actor_identity_id,
             revision.occurred_at AS current_occurred_at
      FROM compute.model_profiles profile
      LEFT JOIN LATERAL (
        SELECT * FROM compute.model_profile_placement_revisions value
        WHERE value.model_profile_id=profile.id
        ORDER BY value.placement_revision DESC LIMIT 1
      ) revision ON true
      WHERE profile.id=$1`, [modelProfileId]))[0];
    return row ? { profile: profile(row), currentRevision: placementRevision(row, "current_") } : null;
  }

}
