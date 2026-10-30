CREATE TABLE platform.maintenance_plans (
    id uuid PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    maintenance_kind text NOT NULL CHECK (maintenance_kind IN ('platform','host')),
    candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate)='object' AND octet_length(candidate::text)<=8192),
    target_nodes jsonb NOT NULL CHECK (jsonb_typeof(target_nodes)='array' AND jsonb_array_length(target_nodes) BETWEEN 1 AND 64 AND octet_length(target_nodes::text)<=32768),
    strategy text NOT NULL CHECK (strategy IN ('rolling','single_node_downtime')),
    plan_state text NOT NULL CHECK (plan_state IN ('blocked','ready','executing','completed','rolled_back','manual_recovery_required')),
    blockers jsonb NOT NULL CHECK (jsonb_typeof(blockers)='array' AND jsonb_array_length(blockers)<=64 AND octet_length(blockers::text)<=8192),
    warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings)='array' AND jsonb_array_length(warnings)<=64 AND octet_length(warnings::text)<=8192),
    backup_evidence jsonb NOT NULL CHECK (jsonb_typeof(backup_evidence)='object' AND octet_length(backup_evidence::text)<=8192),
    preflight_evidence jsonb NOT NULL CHECK (jsonb_typeof(preflight_evidence)='object' AND octet_length(preflight_evidence::text)<=16384),
    compatibility_evidence jsonb NOT NULL CHECK (jsonb_typeof(compatibility_evidence)='object' AND octet_length(compatibility_evidence::text)<=16384),
    revalidation_decision text CHECK (revalidation_decision IS NULL OR revalidation_decision='fence_and_revalidate'),
    recovery_instructions jsonb NOT NULL CHECK (jsonb_typeof(recovery_instructions)='array' AND jsonb_array_length(recovery_instructions) BETWEEN 1 AND 32 AND octet_length(recovery_instructions::text)<=32768),
    rollback_instructions jsonb NOT NULL CHECK (jsonb_typeof(rollback_instructions)='array' AND jsonb_array_length(rollback_instructions) BETWEEN 1 AND 32 AND octet_length(rollback_instructions::text)<=32768),
    current_node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    post_check jsonb CHECK (post_check IS NULL OR (jsonb_typeof(post_check)='object' AND octet_length(post_check::text)<=8192)),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^update_[a-z0-9_.-]{1,120}$'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    requested_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    CHECK (updated_at>=created_at AND (completed_at IS NULL OR completed_at>=created_at)),
    CHECK (
        (plan_state IN ('blocked','ready','executing') AND completed_at IS NULL)
        OR (plan_state IN ('completed','rolled_back','manual_recovery_required') AND completed_at IS NOT NULL)
    ),
    CHECK ((plan_state='executing') OR current_node_id IS NULL),
    CHECK ((plan_state='completed' AND post_check IS NOT NULL AND failure_code IS NULL) OR plan_state<>'completed'),
    CHECK ((plan_state IN ('rolled_back','manual_recovery_required') AND failure_code IS NOT NULL) OR plan_state NOT IN ('rolled_back','manual_recovery_required'))
);

CREATE INDEX maintenance_plans_kind_time_idx ON platform.maintenance_plans (maintenance_kind, created_at DESC, id DESC);
CREATE INDEX maintenance_plans_state_time_idx ON platform.maintenance_plans (plan_state, updated_at DESC, id DESC);

CREATE TABLE platform.maintenance_node_evidence (
    plan_id uuid NOT NULL REFERENCES platform.maintenance_plans(id) ON DELETE CASCADE,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_position integer NOT NULL CHECK (node_position BETWEEN 0 AND 63),
    evidence_state text NOT NULL CHECK (evidence_state IN ('executing','completed','failed')),
    drain_digest bytea,
    apply_digest bytea,
    post_check_digest bytea,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^update_[a-z0-9_.-]{1,120}$'),
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    PRIMARY KEY (plan_id, node_id),
    UNIQUE (plan_id, node_position),
    CHECK (
        (evidence_state='executing' AND drain_digest IS NULL AND apply_digest IS NULL AND post_check_digest IS NULL AND failure_code IS NULL AND completed_at IS NULL)
        OR (evidence_state='completed' AND drain_digest IS NOT NULL AND apply_digest IS NOT NULL AND post_check_digest IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
        OR (evidence_state='failed' AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK (drain_digest IS NULL OR octet_length(drain_digest)=32),
    CHECK (apply_digest IS NULL OR octet_length(apply_digest)=32),
    CHECK (post_check_digest IS NULL OR octet_length(post_check_digest)=32),
    CHECK (completed_at IS NULL OR completed_at>=started_at)
);

CREATE INDEX maintenance_node_evidence_state_idx ON platform.maintenance_node_evidence (evidence_state, started_at DESC);
