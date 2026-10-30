DELETE FROM iam.role_bindings WHERE scope_kind = 'team' AND scope_key = 'team.default';
DROP INDEX iam.role_bindings_one_team_role_idx;
DROP TABLE iam.teams;
