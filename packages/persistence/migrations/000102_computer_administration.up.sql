-- Administrator preferences do not replace installed runtime/storage identities.
CREATE TABLE platform.computer_feature_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled boolean NOT NULL,
    maximum jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(maximum)='object'),
    stored_limit bigint CHECK(stored_limit>=0 AND stored_limit<=9007199254740991),
    running_limit bigint CHECK(running_limit>=0 AND running_limit<=9007199254740991),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    updated_by uuid NOT NULL REFERENCES iam.identities(id),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(stored_limit IS NULL OR running_limit IS NULL OR running_limit<=stored_limit)
);
CREATE TABLE platform.computer_quotas (
    owner_id uuid PRIMARY KEY REFERENCES iam.identities(id),
    stored_limit bigint CHECK(stored_limit>=0 AND stored_limit<=9007199254740991),
    running_limit bigint CHECK(running_limit>=0 AND running_limit<=9007199254740991),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    updated_by uuid NOT NULL REFERENCES iam.identities(id),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(stored_limit IS NULL OR running_limit IS NULL OR running_limit<=stored_limit)
);
