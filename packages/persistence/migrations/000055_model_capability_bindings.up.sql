CREATE TABLE compute.model_capability_bindings (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    binding_key text NOT NULL UNIQUE CHECK (binding_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE RESTRICT,
    api_contract text NOT NULL CHECK (api_contract ~ '^[a-z][a-z0-9_.-]{2,127}@v[0-9]+$'),
    binding_fingerprint text NOT NULL UNIQUE CHECK (binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    configuration_digest text NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('experimental', 'certified', 'disabled')),
    reason_key text NOT NULL CHECK (reason_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    binding_document jsonb NOT NULL CHECK (
        jsonb_typeof(binding_document) = 'object'
        AND binding_document ->> 'schemaVersion' = '1'
        AND binding_document ?& ARRAY[
            'bindingId', 'bindingKey', 'capabilityId', 'physicalModelProfileId',
            'physicalModelProfileKey', 'apiContract', 'configurationDigest',
            'configuration', 'resourceAccounting', 'quality', 'createdAt'
        ]
    ),
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (model_profile_id, capability_id, api_contract),
    CHECK (binding_document ->> 'bindingId' = id::text),
    CHECK (binding_document ->> 'bindingKey' = binding_key),
    CHECK (binding_document ->> 'capabilityId' = capability_id::text),
    CHECK (binding_document ->> 'physicalModelProfileId' = model_profile_id::text),
    CHECK (binding_document ->> 'apiContract' = api_contract),
    CHECK (binding_document ->> 'configurationDigest' = configuration_digest)
);

CREATE INDEX model_capability_bindings_capability_state_idx
ON compute.model_capability_bindings (capability_id, lifecycle_state);

CREATE TRIGGER model_capability_bindings_touch_updated_at
BEFORE UPDATE ON compute.model_capability_bindings
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE FUNCTION compute.reject_model_capability_binding_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.binding_key IS DISTINCT FROM OLD.binding_key
       OR NEW.model_profile_id IS DISTINCT FROM OLD.model_profile_id
       OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
       OR NEW.api_contract IS DISTINCT FROM OLD.api_contract
       OR NEW.binding_fingerprint IS DISTINCT FROM OLD.binding_fingerprint
       OR NEW.configuration_digest IS DISTINCT FROM OLD.configuration_digest
       OR NEW.binding_document IS DISTINCT FROM OLD.binding_document THEN
        RAISE EXCEPTION 'immutable model capability binding identity cannot be changed'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_capability_bindings_identity_immutable
BEFORE UPDATE ON compute.model_capability_bindings
FOR EACH ROW EXECUTE FUNCTION compute.reject_model_capability_binding_identity_mutation();

CREATE TABLE compute.model_capability_binding_opt_ins (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    environment text NOT NULL CHECK (environment IN ('development', 'validation')),
    binding_id uuid NOT NULL REFERENCES compute.model_capability_bindings(id) ON DELETE CASCADE,
    enabled boolean NOT NULL,
    reason_key text NOT NULL CHECK (reason_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    expires_at timestamptz NOT NULL,
    set_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (policy_key, environment, binding_id),
    CHECK (expires_at > created_at)
);

CREATE INDEX model_capability_binding_opt_ins_active_idx
ON compute.model_capability_binding_opt_ins (policy_key, environment, expires_at)
WHERE enabled;

CREATE TRIGGER model_capability_binding_opt_ins_touch_updated_at
BEFORE UPDATE ON compute.model_capability_binding_opt_ins
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
