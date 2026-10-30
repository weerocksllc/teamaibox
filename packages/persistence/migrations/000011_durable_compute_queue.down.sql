DROP TRIGGER job_quota_policies_touch_updated_at ON compute.job_quota_policies;
DROP TABLE compute.job_quota_policies;

DROP INDEX compute.jobs_owner_recent_idx;
DROP INDEX compute.jobs_response_id_idx;

ALTER TABLE compute.jobs
    DROP COLUMN replay_count,
    DROP COLUMN correlation_key,
    DROP COLUMN terminal_error,
    DROP COLUMN result_artifact,
    DROP COLUMN result_schema,
    DROP COLUMN retry_classification,
    DROP COLUMN waiting_reason,
    DROP COLUMN progress_message_key,
    DROP COLUMN progress_value,
    DROP COLUMN progress_sequence,
    DROP COLUMN progress_revision,
    DROP COLUMN data_class,
    DROP COLUMN request_artifact,
    DROP COLUMN request_size_bytes,
    DROP COLUMN request_digest,
    DROP COLUMN route,
    DROP COLUMN response_id,
    DROP COLUMN requested_model_profile_id,
    DROP COLUMN operation;

ALTER TABLE compute.jobs
DROP CONSTRAINT jobs_status_check;

ALTER TABLE compute.jobs
ADD CONSTRAINT jobs_status_check CHECK (
    status IN (
        'queued', 'admitted', 'running', 'succeeded',
        'failed', 'cancelled', 'expired', 'incomplete'
    )
);
