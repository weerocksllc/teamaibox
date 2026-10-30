CREATE TABLE platform.backup_rehearsal_policies (
    id uuid PRIMARY KEY,
    policy_key text NOT NULL UNIQUE CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    backup_target_key text NOT NULL CHECK (backup_target_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    restore_destination_key text NOT NULL CHECK (restore_destination_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    interval_seconds bigint NOT NULL CHECK (interval_seconds BETWEEN 3600 AND 31536000),
    rpo_objective_seconds bigint NOT NULL CHECK (rpo_objective_seconds BETWEEN 60 AND 31536000),
    rto_objective_seconds bigint NOT NULL CHECK (rto_objective_seconds BETWEEN 60 AND 2592000),
    enabled boolean NOT NULL DEFAULT true,
    next_due_at timestamptz NOT NULL,
    last_run_at timestamptz,
    last_run_id uuid,
    lease_id uuid,
    lease_expires_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (updated_at>=created_at),
    CHECK ((last_run_at IS NULL AND last_run_id IS NULL) OR (last_run_at IS NOT NULL)),
    CHECK ((lease_id IS NULL AND lease_expires_at IS NULL) OR (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX backup_rehearsal_policies_due_idx ON platform.backup_rehearsal_policies (next_due_at, id) WHERE enabled;

CREATE TABLE platform.backup_recovery_runs (
    id uuid PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    backup_set_id uuid NOT NULL REFERENCES platform.backup_sets(id) ON DELETE RESTRICT,
    run_kind text NOT NULL CHECK (run_kind IN ('integrity_check','restore_rehearsal','selective_restore','disaster_recovery')),
    destination jsonb CHECK (destination IS NULL OR (jsonb_typeof(destination)='object' AND octet_length(destination::text)<=4096)),
    component_selection jsonb NOT NULL CHECK (jsonb_typeof(component_selection)='array' AND jsonb_array_length(component_selection) BETWEEN 1 AND 7 AND octet_length(component_selection::text)<=1024),
    run_state text NOT NULL CHECK (run_state IN ('running','completed','failed')),
    evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=131072)),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^backup_[a-z0-9_.-]{1,120}$'),
    policy_id uuid REFERENCES platform.backup_rehearsal_policies(id) ON DELETE RESTRICT,
    requested_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    objectives jsonb NOT NULL CHECK (jsonb_typeof(objectives)='object' AND octet_length(objectives::text)<=1024),
    started_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    CHECK (updated_at>=started_at AND (completed_at IS NULL OR completed_at>=started_at)),
    CHECK (
        (run_state='running' AND evidence IS NULL AND failure_code IS NULL AND completed_at IS NULL)
        OR (run_state='completed' AND evidence IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
        OR (run_state='failed' AND evidence IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK ((run_kind='integrity_check' AND destination IS NULL) OR (run_kind<>'integrity_check' AND destination IS NOT NULL))
);

CREATE INDEX backup_recovery_runs_set_time_idx ON platform.backup_recovery_runs (backup_set_id, started_at DESC);
CREATE INDEX backup_recovery_runs_kind_time_idx ON platform.backup_recovery_runs (run_kind, started_at DESC);
CREATE INDEX backup_recovery_runs_policy_time_idx ON platform.backup_recovery_runs (policy_id, started_at DESC) WHERE policy_id IS NOT NULL;

ALTER TABLE platform.backup_rehearsal_policies
    ADD CONSTRAINT backup_rehearsal_policies_last_run_fk
    FOREIGN KEY (last_run_id) REFERENCES platform.backup_recovery_runs(id) ON DELETE RESTRICT;
