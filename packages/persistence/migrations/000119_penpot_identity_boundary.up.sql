-- Platform identity linkage only. Penpot retains its independent native data.
CREATE SCHEMA IF NOT EXISTS design;
CREATE TABLE design.profile_mappings (
    installation_id uuid NOT NULL,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    profile_id uuid NOT NULL UNIQUE,
    PRIMARY KEY (installation_id, identity_id)
);
CREATE TABLE design.login_handoffs (
    code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash)=32),
    installation_id uuid NOT NULL,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL REFERENCES iam.sessions(id) ON DELETE CASCADE,
    app_version text NOT NULL,
    app_generation bigint NOT NULL CHECK (app_generation > 0),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds')
);
CREATE INDEX login_handoffs_expiry ON design.login_handoffs (expires_at);
CREATE TABLE design.native_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    installation_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    session_id uuid NOT NULL REFERENCES iam.sessions(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL,
    app_version text NOT NULL,
    app_generation bigint NOT NULL CHECK (app_generation > 0),
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (installation_id, identity_id) REFERENCES design.profile_mappings(installation_id, identity_id) ON DELETE RESTRICT
);
CREATE INDEX native_sessions_platform_session ON design.native_sessions(session_id);
CREATE INDEX native_sessions_expiry ON design.native_sessions(expires_at);

INSERT INTO iam.permissions(permission_key,description_key)
VALUES ('design:use','permissions.design_use') ON CONFLICT DO NOTHING;
INSERT INTO iam.role_permissions(role_id,permission_key)
SELECT id,'design:use' FROM iam.roles
WHERE role_key IN ('owner','member','team_admin','developer') ON CONFLICT DO NOTHING;
-- This grants application entry, never native project/file ownership or access.
