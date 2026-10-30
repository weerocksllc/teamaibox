CREATE SCHEMA source_center;

CREATE TABLE source_center.sources (
    id uuid PRIMARY KEY,
    source_key text NOT NULL UNIQUE CHECK (source_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    ecosystem text NOT NULL CHECK (ecosystem IN ('pip','npm','apt')),
    source_kind text NOT NULL CHECK (source_kind IN ('hosted','proxy-cache','upstream','mirror','offline-media')),
    priority integer NOT NULL CHECK (priority BETWEEN 0 AND 10000),
    declaration jsonb NOT NULL CHECK (jsonb_typeof(declaration)='object'),
    health jsonb NOT NULL CHECK (jsonb_typeof(health)='object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL,
    CHECK (declaration->>'sourceKey'=source_key),
    CHECK (declaration->>'ecosystem'=ecosystem),
    CHECK (declaration->>'kind'=source_kind),
    CHECK ((declaration->>'priority')::integer=priority)
);

CREATE INDEX source_center_sources_routing_idx
ON source_center.sources (ecosystem,priority,source_key);

CREATE TABLE source_center.policies (
    id uuid PRIMARY KEY,
    policy_key text NOT NULL UNIQUE CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    ecosystem text NOT NULL CHECK (ecosystem IN ('pip','npm','apt')),
    environment text NOT NULL CHECK (environment IN ('agent','application-build','model-build')),
    declaration jsonb NOT NULL CHECK (jsonb_typeof(declaration)='object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL,
    CHECK (declaration->>'policyKey'=policy_key),
    CHECK (declaration->>'ecosystem'=ecosystem),
    CHECK (declaration->>'environment'=environment)
);

CREATE INDEX source_center_policies_routing_idx
ON source_center.policies (ecosystem,environment,policy_key);

CREATE TABLE source_center.health_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES source_center.sources(id) ON DELETE RESTRICT,
    source_revision bigint NOT NULL CHECK (source_revision > 1),
    state text NOT NULL CHECK (state IN ('unknown','healthy','degraded','offline','detached')),
    latency_milliseconds integer CHECK (latency_milliseconds BETWEEN 0 AND 300000),
    error_code text,
    observed_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL,
    UNIQUE (source_id,source_revision)
);

CREATE FUNCTION source_center.reject_health_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'source health history is append-only' USING ERRCODE='23514';
END
$$;

CREATE TRIGGER source_health_events_append_only
BEFORE UPDATE OR DELETE ON source_center.health_events
FOR EACH ROW EXECUTE FUNCTION source_center.reject_health_event_mutation();
