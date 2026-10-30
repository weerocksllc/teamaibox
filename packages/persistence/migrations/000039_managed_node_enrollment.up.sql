ALTER TABLE compute.nodes DROP CONSTRAINT nodes_lifecycle_state_check;
ALTER TABLE compute.nodes ADD CONSTRAINT nodes_lifecycle_state_check CHECK (
    lifecycle_state IN ('joining','ready','draining','offline','disabled','removed')
);

ALTER TABLE compute.nodes
    ADD COLUMN enrollment_id uuid,
    ADD COLUMN certificate_fingerprint bytea CHECK (certificate_fingerprint IS NULL OR octet_length(certificate_fingerprint)=32),
    ADD COLUMN certificate_not_after timestamptz,
    ADD COLUMN certificate_revoked_at timestamptz,
    ADD COLUMN health jsonb NOT NULL DEFAULT '{"state":"unknown","errorCode":null,"observedAt":null}'::jsonb CHECK (jsonb_typeof(health)='object'),
    ADD COLUMN inventory jsonb CHECK (inventory IS NULL OR jsonb_typeof(inventory)='object'),
    ADD COLUMN inventory_digest bytea CHECK (inventory_digest IS NULL OR octet_length(inventory_digest)=32),
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD CONSTRAINT node_inventory_digest_pair CHECK ((inventory IS NULL)=(inventory_digest IS NULL)),
    ADD CONSTRAINT node_certificate_revocation_state CHECK (certificate_revoked_at IS NULL OR lifecycle_state='removed');

CREATE TABLE compute.node_enrollments (
    id uuid PRIMARY KEY,
    node_key text NOT NULL CHECK (node_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
    state text NOT NULL CHECK (state IN ('issued','pending','approved','claimed','revoked','expired')),
    csr_pem text,
    public_key_fingerprint bytea CHECK (public_key_fingerprint IS NULL OR octet_length(public_key_fingerprint)=32),
    requested_agent_version text,
    requested_architecture text CHECK (requested_architecture IS NULL OR requested_architecture='arm64'),
    node_id uuid UNIQUE REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    certificate jsonb CHECK (certificate IS NULL OR jsonb_typeof(certificate)='object'),
    certificate_fingerprint bytea CHECK (certificate_fingerprint IS NULL OR octet_length(certificate_fingerprint)=32),
    certificate_not_after timestamptz,
    claimed_at timestamptz,
    approved_by uuid REFERENCES iam.identities(id) ON DELETE RESTRICT,
    approved_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    expires_at timestamptz NOT NULL,
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (expires_at > created_at),
    CHECK ((state='issued') OR (csr_pem IS NOT NULL AND public_key_fingerprint IS NOT NULL)),
    CHECK (state NOT IN ('approved','claimed') OR node_id IS NOT NULL),
    CHECK (node_id IS NULL OR state IN ('approved','claimed','revoked')),
    CHECK (state<>'claimed' OR (certificate IS NULL AND claimed_at IS NOT NULL))
);

CREATE UNIQUE INDEX node_enrollments_one_active_key_idx
ON compute.node_enrollments (node_key)
WHERE state IN ('issued','pending','approved');

ALTER TABLE compute.nodes
ADD CONSTRAINT nodes_enrollment_fk FOREIGN KEY (enrollment_id)
REFERENCES compute.node_enrollments(id) ON DELETE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE compute.node_heartbeat_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    health_state text NOT NULL CHECK (health_state IN ('healthy','degraded')),
    inventory_digest bytea NOT NULL CHECK (octet_length(inventory_digest)=32),
    observed_at timestamptz NOT NULL
);

CREATE INDEX node_heartbeat_events_node_time_idx
ON compute.node_heartbeat_events (node_id,observed_at DESC,event_id DESC);

CREATE FUNCTION compute.reject_node_heartbeat_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'node heartbeat evidence is append-only' USING ERRCODE='23514';
END
$$;

CREATE TRIGGER node_heartbeat_events_append_only
BEFORE UPDATE OR DELETE ON compute.node_heartbeat_events
FOR EACH ROW EXECUTE FUNCTION compute.reject_node_heartbeat_mutation();
