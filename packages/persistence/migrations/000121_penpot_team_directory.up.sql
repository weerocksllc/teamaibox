-- Stable links only. Native files, ownership and ACLs remain in Penpot.
CREATE TABLE design.team_mappings (
    installation_id uuid NOT NULL,
    platform_team_id uuid NOT NULL REFERENCES iam.teams(id) ON DELETE RESTRICT,
    native_team_id uuid NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    PRIMARY KEY (installation_id, platform_team_id)
);
