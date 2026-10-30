-- Refuse incompatible downgrade without deleting any task or work part.
ALTER TABLE compute.asr_shard_plans
    DROP CONSTRAINT asr_shard_plans_source_duration_milliseconds_check,
    DROP CONSTRAINT asr_shard_plans_shard_count_check;
ALTER TABLE compute.asr_shard_plans
    ADD CONSTRAINT asr_shard_plans_source_duration_milliseconds_check
    CHECK (source_duration_milliseconds BETWEEN 1 AND 604800000),
    ADD CONSTRAINT asr_shard_plans_shard_count_check CHECK (shard_count BETWEEN 1 AND 10080);
