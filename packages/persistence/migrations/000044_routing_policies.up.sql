CREATE TABLE compute.routing_policies (
    id uuid PRIMARY KEY,
    policy_key text NOT NULL UNIQUE CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
    selector jsonb NOT NULL CHECK (
        jsonb_typeof(selector)='object'
        AND selector ?& ARRAY['capabilityId','operation','teamId','dataClasses']
    ),
    priority integer NOT NULL CHECK (priority BETWEEN 0 AND 10000),
    mode text NOT NULL CHECK (mode IN ('internal_only','internal_first','external_first','weighted','pinned')),
    external_processing_approved boolean NOT NULL DEFAULT false,
    pinned_target_id text CHECK (pinned_target_id IS NULL OR pinned_target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
    pinned_profile_id text CHECK (pinned_profile_id IS NULL OR pinned_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
    target_weights jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(target_weights)='object'),
    enabled boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (mode='pinned' AND (pinned_target_id IS NOT NULL OR pinned_profile_id IS NOT NULL))
        OR (mode<>'pinned')
    )
);

CREATE INDEX routing_policies_resolution_idx
ON compute.routing_policies (enabled, priority DESC, policy_key)
WHERE enabled;

CREATE TRIGGER routing_policies_touch_updated_at
BEFORE UPDATE ON compute.routing_policies
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
