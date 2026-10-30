-- A runtime installation is still required. This switch cannot grant access to
-- phone content or override the installed node/storage/resource policy.
CREATE TABLE platform.phone_feature_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740990),
  updated_by uuid NOT NULL REFERENCES iam.identities(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
