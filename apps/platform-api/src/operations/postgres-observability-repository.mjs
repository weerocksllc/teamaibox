function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL observability result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function date(value) { return value == null ? null : new Date(value); }
function target(row) { return Object.freeze({ kind: row.target_kind, key: row.target_key }); }
function producer(row) { return Object.freeze({ kind: row.producer_kind, key: row.producer_key }); }
function signal(row) { return row ? { signalId: row.id, kind: row.signal_kind, correlationId: row.correlation_id, producer: producer(row), eventKey: row.event_key, severity: row.severity, observedAt: date(row.observed_at), data: json(row.data), facts: json(row.facts), jobIds: [...(row.job_ids ?? [])], attemptIds: [...(row.attempt_ids ?? [])] } : null; }
function health(row) { return row ? { healthId: row.id, correlationId: row.correlation_id, target: target(row), state: row.health_state, reasonCode: row.reason_code, observedAt: date(row.observed_at), facts: json(row.facts), signalId: row.signal_id } : null; }
function alert(row) { return row ? { alertId: row.id, alertKey: row.alert_key, severity: row.severity, status: row.alert_status, target: target(row), correlationId: row.correlation_id, titleKey: row.title_key, detailKey: row.detail_key, facts: json(row.facts), signalIds: [...row.signal_ids], jobIds: [...row.job_ids], occurrenceCount: Number(row.occurrence_count), openedAt: date(row.opened_at), lastSeenAt: date(row.last_seen_at), resolvedAt: date(row.resolved_at) } : null; }

export class PostgresObservabilityRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required"); this.#database = database; }

  async insertSignal(value) {
    const row = rows(await this.#database.query(`INSERT INTO platform.diagnostic_signals
      (id,signal_kind,correlation_id,producer_kind,producer_key,event_key,severity,observed_at,data,facts,job_ids,attempt_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::uuid[],$12::uuid[]) RETURNING *`,
    [value.signalId, value.kind, value.correlationId, value.producer.kind, value.producer.key, value.eventKey,
      value.severity, value.observedAt, JSON.stringify(value.data), JSON.stringify(value.facts), value.jobIds, value.attemptIds]))[0];
    return signal(row);
  }

  async insertHealth(value) {
    const row = rows(await this.#database.query(`INSERT INTO platform.health_signals
      (id,correlation_id,target_kind,target_key,health_state,reason_code,observed_at,facts,signal_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
    [value.healthId, value.correlationId, value.target.kind, value.target.key, value.state, value.reasonCode,
      value.observedAt, JSON.stringify(value.facts), value.signalId]))[0];
    return health(row);
  }

  async listSignals({ since = null, until = null, correlationId = null, producerKinds = null, limit = 1000, before = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM platform.diagnostic_signals
      WHERE ($1::timestamptz IS NULL OR observed_at >= $1) AND ($2::timestamptz IS NULL OR observed_at <= $2)
        AND ($3::text IS NULL OR correlation_id=$3) AND ($4::text[] IS NULL OR producer_kind=ANY($4))
        AND ($6::timestamptz IS NULL OR (observed_at,id) < ($6::timestamptz,$7::uuid))
      ORDER BY observed_at DESC,id DESC LIMIT $5`, [since, until, correlationId, producerKinds, limit, before?.at ?? null, before?.id ?? null])).map(signal);
  }

  async listHealth({ since = null, until = null, correlationId = null, targetKinds = null, limit = 1000, before = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM platform.health_signals
      WHERE ($1::timestamptz IS NULL OR observed_at >= $1) AND ($2::timestamptz IS NULL OR observed_at <= $2)
        AND ($3::text IS NULL OR correlation_id=$3) AND ($4::text[] IS NULL OR target_kind=ANY($4))
        AND ($6::timestamptz IS NULL OR (observed_at,id) < ($6::timestamptz,$7::uuid))
      ORDER BY observed_at DESC,id DESC LIMIT $5`, [since, until, correlationId, targetKinds, limit, before?.at ?? null, before?.id ?? null])).map(health);
  }

  async currentHealth() {
    // Jump to the next target in the existing composite index. DISTINCT ON
    // scans every historical observation even though the UI needs one per target.
    return rows(await this.#database.query(`WITH RECURSIVE latest AS (
      (SELECT * FROM platform.health_signals ORDER BY target_kind,target_key,observed_at DESC,id DESC LIMIT 1)
      UNION ALL
      SELECT next_target.* FROM latest previous CROSS JOIN LATERAL (
        SELECT * FROM platform.health_signals
        WHERE (target_kind,target_key) > (previous.target_kind,previous.target_key)
        ORDER BY target_kind,target_key,observed_at DESC,id DESC LIMIT 1
      ) next_target
    ) SELECT * FROM latest ORDER BY target_kind,target_key`)).map(health);
  }

  async upsertAlert(value) {
    const row = rows(await this.#database.query(`INSERT INTO platform.operational_alerts
      (id,alert_key,severity,alert_status,target_kind,target_key,correlation_id,title_key,detail_key,facts,signal_ids,job_ids,occurrence_count,opened_at,last_seen_at,resolved_at)
      VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9::jsonb,$10::uuid[],$11::uuid[],$12,$13,$14,NULL)
      ON CONFLICT (alert_key) DO UPDATE SET severity=EXCLUDED.severity,alert_status='open',correlation_id=EXCLUDED.correlation_id,
        title_key=EXCLUDED.title_key,detail_key=EXCLUDED.detail_key,facts=EXCLUDED.facts,
        signal_ids=ARRAY(SELECT DISTINCT value FROM unnest(platform.operational_alerts.signal_ids || EXCLUDED.signal_ids) AS item(value)),
        job_ids=ARRAY(SELECT DISTINCT value FROM unnest(platform.operational_alerts.job_ids || EXCLUDED.job_ids) AS item(value)),
        occurrence_count=platform.operational_alerts.occurrence_count+1,last_seen_at=EXCLUDED.last_seen_at,resolved_at=NULL
      RETURNING *`, [value.alertId, value.alertKey, value.severity, value.target.kind, value.target.key,
      value.correlationId, value.titleKey, value.detailKey, JSON.stringify(value.facts), value.signalIds,
      value.jobIds, value.occurrenceCount, value.openedAt, value.lastSeenAt]))[0];
    return alert(row);
  }

  async resolveAlert(alertKey, { correlationId, resolvedAt }) {
    const row = rows(await this.#database.query(`UPDATE platform.operational_alerts SET alert_status='resolved',
      correlation_id=$2,last_seen_at=$3,resolved_at=$3 WHERE alert_key=$1 AND alert_status <> 'resolved' RETURNING *`,
    [alertKey, correlationId, resolvedAt]))[0];
    if (row) return alert(row);
    return alert(rows(await this.#database.query(`SELECT * FROM platform.operational_alerts WHERE alert_key=$1`, [alertKey]))[0]);
  }

  async listAlerts({ since = null, until = null, correlationId = null, statuses = null, targetKinds = null, limit = 1000, before = null } = {}) {
    return rows(await this.#database.query(`SELECT * FROM platform.operational_alerts
      WHERE ($1::timestamptz IS NULL OR last_seen_at >= $1) AND ($2::timestamptz IS NULL OR last_seen_at <= $2)
        AND ($3::text IS NULL OR correlation_id=$3) AND ($4::text[] IS NULL OR alert_status=ANY($4))
        AND ($5::text[] IS NULL OR target_kind=ANY($5))
        AND ($7::timestamptz IS NULL OR (last_seen_at,id) < ($7::timestamptz,$8::uuid)) ORDER BY last_seen_at DESC,id DESC LIMIT $6`,
    [since, until, correlationId, statuses, targetKinds, limit, before?.at ?? null, before?.id ?? null])).map(alert);
  }

  async lookupJobIdsByAttemptIds(attemptIds) {
    if (attemptIds.length === 0) return [];
    return rows(await this.#database.query(`SELECT DISTINCT unnest(job_ids) AS job_id FROM platform.diagnostic_signals
      WHERE attempt_ids && $1::uuid[] ORDER BY job_id`, [attemptIds])).map((row) => row.job_id);
  }

  async recordExport(value) {
    await this.#database.query(`INSERT INTO platform.diagnostic_exports
      (id,requested_by,filters,sensitive_included,access_reason,bundle_digest,signal_count,health_count,alert_count,content_count,created_at,expires_at)
      VALUES ($1,$2,$3::jsonb,$4,$5,decode(substring($6 from 8),'hex'),$7,$8,$9,$10,$11,$12)`,
    [value.exportId, value.requestedBy, JSON.stringify(value.filters), value.sensitiveIncluded, value.accessReason,
      value.bundleDigest, value.signalCount, value.healthCount, value.alertCount, value.contentCount, value.createdAt, value.expiresAt]);
    return structuredClone(value);
  }

  async purgeBefore({ signalCutoffs, healthBefore, exportBefore, resolvedAlertBefore }) {
    return this.#database.transaction(async (transaction) => {
      const deletedHealth = rows(await transaction.query(`DELETE FROM platform.health_signals WHERE observed_at<$1 RETURNING id`, [healthBefore])).length;
      const deletedExports = rows(await transaction.query(`DELETE FROM platform.diagnostic_exports WHERE created_at<$1 RETURNING id`, [exportBefore])).length;
      const deletedAlerts = rows(await transaction.query(`DELETE FROM platform.operational_alerts WHERE alert_status='resolved' AND resolved_at<$1 RETURNING id`, [resolvedAlertBefore])).length;
      const deletedSignals = rows(await transaction.query(`DELETE FROM platform.diagnostic_signals signal WHERE
        ((signal_kind='log' AND observed_at<$1) OR (signal_kind='metric' AND observed_at<$2) OR (signal_kind='trace' AND observed_at<$3))
        AND NOT EXISTS (SELECT 1 FROM platform.health_signals health WHERE health.signal_id=signal.id)
        AND NOT EXISTS (SELECT 1 FROM platform.operational_alerts alert WHERE alert.alert_status='open' AND signal.id=ANY(alert.signal_ids))
        RETURNING id`, [signalCutoffs.log, signalCutoffs.metric, signalCutoffs.trace])).length;
      return { signals: deletedSignals, health: deletedHealth, exports: deletedExports, alerts: deletedAlerts };
    });
  }
}
