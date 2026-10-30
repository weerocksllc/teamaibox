import {bufferedMediaBytes} from '../../../../services/object-service/src/buffered-media-budget.mjs';

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function timestamp(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("PostgreSQL SHA-256 value is invalid");
  }
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function lifecycle(row) {
  if (!row) return null;
  return {
    state: row.certification_state,
    revision: Number(row.lifecycle_revision),
    reasonKey: row.lifecycle_reason_key,
    evidenceRefs: json(row.lifecycle_evidence_refs) ?? [],
    validationRunId: row.lifecycle_validation_run_id,
    updatedAt: timestamp(row.lifecycle_updated_at),
  };
}

function validationRuns(resultRows) {
  const runs = new Map();
  for (const row of resultRows) {
    let run = runs.get(row.run_id);
    if (!run) {
      run = {
        runId: row.run_id,
        state: row.run_state,
        plan: json(row.plan),
        createdAt: timestamp(row.run_created_at),
        updatedAt: timestamp(row.run_updated_at),
        environmentDigest: null,
        environmentDigests: [],
        stages: [],
      };
      runs.set(row.run_id, run);
    }
    if (row.ordinal === null || row.ordinal === undefined) continue;
    const result = json(row.stage_result);
    run.stages.push({
      ordinal: Number(row.ordinal),
      stage: row.stage,
      state: row.stage_state,
      result,
    });
    const environmentDigest = result?.environmentDigest;
    if (typeof environmentDigest === "string" && !run.environmentDigests.includes(environmentDigest)) {
      run.environmentDigests.push(environmentDigest);
    }
  }
  for (const run of runs.values()) {
    run.stages.sort((left, right) => left.ordinal - right.ordinal);
    run.environmentDigests.sort();
    run.environmentDigest = run.environmentDigests.length === 1 ? run.environmentDigests[0] : null;
  }
  return [...runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function comparisonEvidence(resultRows) {
  const evidence = new Map();
  for (const row of resultRows) {
    const result = json(row.stage_result);
    for (const item of result?.evidence ?? []) {
      if (!item || typeof item !== "object" || typeof item.kind !== "string"
        || !item.kind.includes("comparison") || typeof item.reference !== "string"
        || typeof item.digest !== "string") continue;
      evidence.set(item.digest, {
        reference: item.reference,
        digest: item.digest,
        mediaType: item.mediaType,
        sizeBytes: item.sizeBytes,
      });
    }
  }
  return [...evidence.values()];
}

function acceptedComparison(document, profileKey, rawReference) {
  if (!document || typeof document !== "object" || Array.isArray(document)
    || typeof document.comparisonKind !== "string" || typeof document.outcome !== "string") return null;
  const candidate = document.candidate?.profileKey;
  const reference = document.reference?.profileKey;
  if (candidate !== profileKey && reference !== profileKey) return null;
  return {
    ...structuredClone(document),
    rawEvidenceRefs: [...new Set([...(document.rawEvidenceRefs ?? []), rawReference])],
  };
}

export class PostgresModelReportCatalog {
  #database;
  #evidenceReader;

  constructor({ database, evidenceReader = null }) {
    if (!database?.query) throw new TypeError("PostgreSQL database adapter is required");
    if (evidenceReader !== null && typeof evidenceReader.readJson !== "function") {
      throw new TypeError("protected model evidence reader is invalid");
    }
    this.#database = database;
    this.#evidenceReader = evidenceReader;
  }

  async getProfile(profileKey) {
    const row = rows(await this.#database.query(`
      SELECT registration.profile_document, registration.profile_fingerprint
      FROM compute.model_profile_registrations registration
      JOIN compute.model_profiles profile ON profile.id = registration.profile_id
      JOIN compute.capabilities capability ON capability.id = profile.capability_id
      WHERE registration.profile_key = $1 AND capability.lifecycle_state <> 'retired'`, [profileKey]))[0];
    if (!row) return null;
    return {
      profile: json(row.profile_document),
      fingerprint: digest(row.profile_fingerprint),
    };
  }

  async getLifecycle(profileId) {
    return lifecycle(rows(await this.#database.query(`
      SELECT certification_state, lifecycle_revision, lifecycle_reason_key,
             lifecycle_evidence_refs, lifecycle_validation_run_id,
             lifecycle_updated_at
      FROM compute.model_profiles
      WHERE id = $1`, [profileId]))[0]);
  }

  async listValidationRuns(profileKey) {
    return validationRuns(rows(await this.#database.query(`
      SELECT run.id AS run_id, run.state AS run_state, run.plan,
             run.created_at AS run_created_at, run.updated_at AS run_updated_at,
             stage.ordinal, stage.stage, stage.state AS stage_state,
             stage.result AS stage_result
      FROM compute.model_validation_runs run
      LEFT JOIN compute.model_validation_stages stage ON stage.run_id = run.id
      WHERE run.profile_key = $1
      ORDER BY run.created_at DESC, stage.ordinal ASC`, [profileKey])));
  }

  async listComparisons(profileKey) {
    if (!this.#evidenceReader) return [];
    const resultRows = rows(await this.#database.query(`
      SELECT stage.result AS stage_result
      FROM compute.model_validation_runs run
      JOIN compute.model_validation_stages stage ON stage.run_id = run.id
      WHERE run.profile_key = $1 AND stage.stage = 'benchmark'
        AND stage.result IS NOT NULL
      ORDER BY run.created_at DESC`, [profileKey]));
    const documents=[];
    // Read sequentially: a longer report must not launch every object download
    // at once or silently hide older comparisons.
    for(const evidence of comparisonEvidence(resultRows)) {
      const document = await this.#evidenceReader.readJson({
        ...evidence,
        maximumBytes: bufferedMediaBytes(),
      });
      documents.push(acceptedComparison(document, profileKey, evidence.reference));
    }
    return documents.filter(Boolean);
  }
}
