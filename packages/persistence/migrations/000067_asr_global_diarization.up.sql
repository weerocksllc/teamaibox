ALTER TABLE compute.asr_shard_plans
ADD COLUMN profile_options jsonb,
ADD COLUMN diarization_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
ADD COLUMN diarization_sha256 bytea CHECK (
    diarization_sha256 IS NULL OR octet_length(diarization_sha256) = 32
),
ADD COLUMN diarization_completed_at timestamptz,
ADD CONSTRAINT asr_shard_plans_profile_options_shape CHECK (
    profile_options IS NULL OR jsonb_typeof(profile_options) = 'object'
),
ADD CONSTRAINT asr_shard_plans_diarization_complete CHECK (
    (diarization_artifact_id IS NULL AND diarization_sha256 IS NULL AND diarization_completed_at IS NULL)
    OR
    (diarization_artifact_id IS NOT NULL AND diarization_sha256 IS NOT NULL AND diarization_completed_at IS NOT NULL)
);

CREATE INDEX asr_shard_plans_diarization_artifact_idx
ON compute.asr_shard_plans (diarization_artifact_id)
WHERE diarization_artifact_id IS NOT NULL;
