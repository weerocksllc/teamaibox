-- Pilot schema, not yet registered in the appliance migration manifest.
-- Mapping survives session expiry; removing access must not remove designs.
CREATE SCHEMA IF NOT EXISTS design;
CREATE TABLE design.profile_mappings (
  installation_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  profile_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (installation_id, identity_id)
);
CREATE TABLE design.login_handoffs (
  code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash)=32),
  installation_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  session_id uuid NOT NULL,
  app_version text NOT NULL,
  app_generation bigint NOT NULL CHECK (app_generation > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds')
);
CREATE INDEX login_handoffs_expiry ON design.login_handoffs (expires_at);
