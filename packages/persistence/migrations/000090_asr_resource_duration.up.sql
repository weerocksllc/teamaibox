-- Media duration and number of work parts are not product quotas.
-- The planner performs memory admission; each worker retains its own cgroup.
ALTER TABLE compute.asr_shard_plans
    DROP CONSTRAINT asr_shard_plans_source_duration_milliseconds_check,
    DROP CONSTRAINT asr_shard_plans_shard_count_check;
ALTER TABLE compute.asr_shard_plans
    ADD CONSTRAINT asr_shard_plans_source_duration_milliseconds_check
    CHECK (source_duration_milliseconds >= 1),
    ADD CONSTRAINT asr_shard_plans_shard_count_check CHECK (shard_count >= 1);
