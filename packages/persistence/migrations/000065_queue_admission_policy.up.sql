CREATE TABLE compute.queue_admission_policies (
    policy_key text PRIMARY KEY CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    minimum_priority smallint NOT NULL CHECK (minimum_priority BETWEEN 0 AND 100),
    maximum_priority smallint NOT NULL CHECK (maximum_priority BETWEEN 0 AND 100),
    max_queued_per_owner integer NOT NULL CHECK (max_queued_per_owner BETWEEN 1 AND 4096),
    max_active_per_owner integer NOT NULL CHECK (max_active_per_owner BETWEEN 1 AND 1024),
    max_queued_per_capability integer NOT NULL CHECK (max_queued_per_capability BETWEEN 1 AND 32768),
    max_daily_submissions_per_owner integer NOT NULL CHECK (max_daily_submissions_per_owner BETWEEN 1 AND 1000000),
    max_request_bytes integer NOT NULL CHECK (max_request_bytes BETWEEN 1024 AND 16777216),
    max_deadline_milliseconds bigint NOT NULL CHECK (max_deadline_milliseconds BETWEEN 60000 AND 2592000000),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (minimum_priority <= maximum_priority)
);

INSERT INTO compute.queue_admission_policies (
    policy_key, minimum_priority, maximum_priority,
    max_queued_per_owner, max_active_per_owner, max_queued_per_capability,
    max_daily_submissions_per_owner, max_request_bytes, max_deadline_milliseconds
) VALUES ('default', 0, 100, 64, 4, 256, 1000, 1048576, 604800000);

CREATE TRIGGER queue_admission_policies_touch_updated_at
BEFORE UPDATE ON compute.queue_admission_policies
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
