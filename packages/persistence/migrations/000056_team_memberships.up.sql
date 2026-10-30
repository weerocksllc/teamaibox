CREATE TABLE iam.teams (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    team_key text NOT NULL UNIQUE CHECK (team_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    system_team boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX teams_single_system_team_idx ON iam.teams (system_team) WHERE system_team;
CREATE UNIQUE INDEX role_bindings_one_team_role_idx
ON iam.role_bindings (identity_id, scope_key)
WHERE scope_kind = 'team';

INSERT INTO iam.teams (id, team_key, display_name, status, system_team)
VALUES ('00000000-0000-7000-8000-000000000001', 'team.default', 'Default team', 'active', true);

INSERT INTO iam.role_bindings (
    identity_id, role_id, scope_kind, scope_key, granted_by, granted_at, expires_at
)
SELECT identity.id,
       CASE WHEN EXISTS (
         SELECT 1
         FROM iam.role_bindings owner_binding
         JOIN iam.roles owner_role ON owner_role.id = owner_binding.role_id
         WHERE owner_binding.identity_id = identity.id
           AND owner_binding.scope_kind = 'appliance'
           AND owner_binding.scope_key = '*'
           AND owner_role.role_key = 'owner'
           AND (owner_binding.expires_at IS NULL OR owner_binding.expires_at > clock_timestamp())
       ) THEN team_admin_role.id ELSE member_role.id END,
       'team',
       'team.default',
       NULL,
       clock_timestamp(),
       NULL
FROM iam.identities identity
CROSS JOIN iam.roles member_role
CROSS JOIN iam.roles team_admin_role
WHERE identity.identity_kind = 'local_user'
  AND member_role.role_key = 'member'
  AND team_admin_role.role_key = 'team_admin'
ON CONFLICT DO NOTHING;
