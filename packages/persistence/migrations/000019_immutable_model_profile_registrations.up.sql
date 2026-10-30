CREATE TABLE compute.model_profile_registrations (
    profile_id uuid PRIMARY KEY REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    profile_key text NOT NULL UNIQUE CHECK (
        profile_key ~ '^[a-z][a-z0-9_.-]{2,191}$'
    ),
    profile_fingerprint bytea NOT NULL UNIQUE CHECK (
        octet_length(profile_fingerprint) = 32
    ),
    profile_document jsonb NOT NULL CHECK (
        jsonb_typeof(profile_document) = 'object'
        AND profile_document ->> 'schemaVersion' = '1'
        AND profile_document ?& ARRAY[
            'profileId', 'profileKey', 'capabilityId', 'executionKind',
            'source', 'artifacts', 'artifactDigest', 'engine', 'precision',
            'quantizationRecipe', 'compatibility', 'apiContracts', 'limits',
            'resourceEnvelope', 'coldStart', 'dataPolicy', 'knownLimitations',
            'validationEvidence', 'certification', 'exclusive', 'createdAt'
        ]
    ),
    registered_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    operation_key text NOT NULL UNIQUE CHECK (
        operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    created_at timestamptz NOT NULL,
    CHECK (profile_document ->> 'profileId' = profile_id::text),
    CHECK (profile_document ->> 'profileKey' = profile_key),
    CHECK (profile_document ->> 'createdAt' = to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE FUNCTION compute.reject_model_profile_registration_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'immutable model profile registration cannot be changed'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER model_profile_registrations_immutable
BEFORE UPDATE OR DELETE ON compute.model_profile_registrations
FOR EACH ROW EXECUTE FUNCTION compute.reject_model_profile_registration_mutation();

CREATE INDEX model_profile_registrations_source_idx
ON compute.model_profile_registrations (
    (profile_document #>> '{source,model}'),
    (profile_document #>> '{source,revision}'),
    (profile_document ->> 'precision')
);
