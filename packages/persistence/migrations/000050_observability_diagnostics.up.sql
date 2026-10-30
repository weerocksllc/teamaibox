INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('operations:view', 'permissions.operations_view'),
    ('operations:manage', 'permissions.operations_manage'),
    ('diagnostic_sensitive:view', 'permissions.diagnostic_sensitive_view');

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, mapping.permission_key
FROM iam.roles role
JOIN (VALUES
    ('owner', 'operations:view'),
    ('owner', 'operations:manage'),
    ('owner', 'diagnostic_sensitive:view'),
    ('system_admin', 'operations:view'),
    ('system_admin', 'operations:manage'),
    ('system_admin', 'diagnostic_sensitive:view'),
    ('compute_admin', 'operations:view'),
    ('compute_admin', 'operations:manage')
) AS mapping(role_key, permission_key)
ON role.role_key = mapping.role_key;

CREATE TABLE platform.diagnostic_signals (
    id uuid PRIMARY KEY,
    signal_kind text NOT NULL CHECK (signal_kind IN ('log','metric','trace')),
    correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    producer_kind text NOT NULL CHECK (producer_kind IN ('core_service','plugin','node','worker','provider','software_source','storage_pool','network_link')),
    producer_key text NOT NULL CHECK (producer_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
    event_key text NOT NULL CHECK (event_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    severity text NOT NULL CHECK (severity IN ('debug','info','warning','error','critical')),
    observed_at timestamptz NOT NULL,
    data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=8192),
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=16384),
    job_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(job_ids)<=256),
    attempt_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(attempt_ids)<=256)
);

CREATE INDEX diagnostic_signals_correlation_time_idx
ON platform.diagnostic_signals (correlation_id, observed_at DESC, id DESC);

CREATE INDEX diagnostic_signals_producer_time_idx
ON platform.diagnostic_signals (producer_kind, producer_key, observed_at DESC);

CREATE INDEX diagnostic_signals_job_ids_idx
ON platform.diagnostic_signals USING gin (job_ids);

CREATE INDEX diagnostic_signals_attempt_ids_idx
ON platform.diagnostic_signals USING gin (attempt_ids);

CREATE TABLE platform.health_signals (
    id uuid PRIMARY KEY,
    correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    target_kind text NOT NULL CHECK (target_kind IN ('core_service','plugin','node','worker','provider','software_source','storage_pool','network_link')),
    target_key text NOT NULL CHECK (target_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
    health_state text NOT NULL CHECK (health_state IN ('unknown','healthy','degraded','unavailable')),
    reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    observed_at timestamptz NOT NULL,
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=16384),
    signal_id uuid REFERENCES platform.diagnostic_signals(id) ON DELETE SET NULL,
    CHECK (health_state<>'healthy' OR reason_code IS NULL)
);

CREATE INDEX health_signals_target_time_idx
ON platform.health_signals (target_kind, target_key, observed_at DESC, id DESC);

CREATE INDEX health_signals_correlation_time_idx
ON platform.health_signals (correlation_id, observed_at DESC);

CREATE TABLE platform.operational_alerts (
    id uuid PRIMARY KEY,
    alert_key text NOT NULL UNIQUE CHECK (length(alert_key) BETWEEN 3 AND 512),
    severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
    alert_status text NOT NULL CHECK (alert_status IN ('open','resolved')),
    target_kind text NOT NULL CHECK (target_kind IN ('core_service','plugin','node','worker','provider','software_source','storage_pool','network_link')),
    target_key text NOT NULL CHECK (target_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
    correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    title_key text NOT NULL CHECK (title_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    detail_key text NOT NULL CHECK (detail_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=16384),
    signal_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(signal_ids)<=256),
    job_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(job_ids)<=256),
    occurrence_count bigint NOT NULL CHECK (occurrence_count BETWEEN 1 AND 9007199254740991),
    opened_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    resolved_at timestamptz,
    CHECK ((alert_status='open' AND resolved_at IS NULL) OR (alert_status='resolved' AND resolved_at IS NOT NULL)),
    CHECK (last_seen_at>=opened_at),
    CHECK (resolved_at IS NULL OR resolved_at>=opened_at)
);

CREATE INDEX operational_alerts_status_time_idx
ON platform.operational_alerts (alert_status, severity, last_seen_at DESC);

CREATE INDEX operational_alerts_correlation_idx
ON platform.operational_alerts (correlation_id, last_seen_at DESC);

CREATE TABLE platform.diagnostic_exports (
    id uuid PRIMARY KEY,
    requested_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object' AND octet_length(filters::text)<=8192),
    sensitive_included boolean NOT NULL,
    access_reason text CHECK (
        (sensitive_included AND length(access_reason) BETWEEN 8 AND 256)
        OR (NOT sensitive_included AND access_reason IS NULL)
    ),
    bundle_digest bytea NOT NULL CHECK (octet_length(bundle_digest)=32),
    signal_count integer NOT NULL CHECK (signal_count BETWEEN 0 AND 5000),
    health_count integer NOT NULL CHECK (health_count BETWEEN 0 AND 5000),
    alert_count integer NOT NULL CHECK (alert_count BETWEEN 0 AND 5000),
    content_count integer NOT NULL CHECK (content_count BETWEEN 0 AND 100),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at>created_at)
);

CREATE INDEX diagnostic_exports_requester_time_idx
ON platform.diagnostic_exports (requested_by, created_at DESC);

CREATE INDEX diagnostic_exports_expiry_idx
ON platform.diagnostic_exports (expires_at);
