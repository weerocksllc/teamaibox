\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

INSERT INTO compute.nodes (
    id, node_key, architecture, trust_kind, lifecycle_state, appliance_role
) VALUES (
    '00000000-0000-4000-8000-000000006901'::uuid,
    'casting-local-smoke', 'arm64', 'managed_appliance', 'ready', 'appliance-core'
);

INSERT INTO iam.identities (
    identity_kind, login_name, normalized_login_name,
    display_name, password_hash
)
SELECT 'local_user', login_name, login_name, display_name,
       '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
FROM (VALUES
    ('cast-initiator-smoke', 'Cast Initiator'),
    ('cast-viewer-01-smoke', 'Cast Viewer 01'),
    ('cast-viewer-02-smoke', 'Cast Viewer 02'),
    ('cast-viewer-03-smoke', 'Cast Viewer 03'),
    ('cast-viewer-04-smoke', 'Cast Viewer 04'),
    ('cast-viewer-05-smoke', 'Cast Viewer 05'),
    ('cast-viewer-06-smoke', 'Cast Viewer 06'),
    ('cast-viewer-07-smoke', 'Cast Viewer 07'),
    ('cast-viewer-08-smoke', 'Cast Viewer 08'),
    ('cast-viewer-09-smoke', 'Cast Viewer 09'),
    ('cast-use-only-smoke', 'Cast Without Viewing'),
    ('cast-outsider-smoke', 'Cast Outsider')
) AS fixture(login_name, display_name);

INSERT INTO iam.role_bindings (
    identity_id, role_id, scope_kind, scope_key
)
SELECT identity.id,
       CASE
           WHEN identity.normalized_login_name = 'cast-initiator-smoke'
           THEN team_admin.id
           ELSE member.id
       END,
       'team', 'team.default'
FROM iam.identities identity
CROSS JOIN iam.roles member
CROSS JOIN iam.roles team_admin
WHERE identity.normalized_login_name LIKE 'cast-%-smoke'
  AND identity.normalized_login_name <> 'cast-use-only-smoke'
  AND member.role_key = 'member'
  AND team_admin.role_key = 'team_admin';

INSERT INTO iam.roles (role_key, display_name_key, description_key, system_role)
VALUES ('cast-use-only-smoke', 'roles.cast_smoke.name', 'roles.cast_smoke.description', false);
INSERT INTO iam.role_scopes (role_id, scope_kind)
SELECT id, 'team' FROM iam.roles WHERE role_key = 'cast-use-only-smoke';
INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT id, 'cast:use' FROM iam.roles WHERE role_key = 'cast-use-only-smoke';
INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key)
SELECT identity.id, role.id, 'team', 'team.default'
FROM iam.identities identity CROSS JOIN iam.roles role
WHERE identity.normalized_login_name = 'cast-use-only-smoke'
  AND role.role_key = 'cast-use-only-smoke';

INSERT INTO iam.teams (id, team_key, display_name, status)
VALUES (
    '00000000-0000-4000-8000-000000006902'::uuid,
    'cast-smoke-team', 'Cast Smoke Team', 'active'
);

INSERT INTO iam.role_bindings (
    identity_id, role_id, scope_kind, scope_key
)
SELECT identity.id, role.id, 'team', 'cast-smoke-team'
FROM iam.identities identity
JOIN iam.roles role ON role.role_key = 'member'
WHERE identity.normalized_login_name = 'cast-viewer-01-smoke';

INSERT INTO platform.cast_sessions (
    id, appliance_node_id, initiator_identity_id,
    output_sinks, browser_audience, expires_at
)
SELECT '00000000-0000-4000-8000-000000006910'::uuid,
       '00000000-0000-4000-8000-000000006901'::uuid,
       identity.id,
       ARRAY['browser']::text[],
       'selected_users',
       clock_timestamp() + interval '2 hours'
FROM iam.identities identity
WHERE identity.normalized_login_name = 'cast-initiator-smoke';

INSERT INTO platform.cast_audience_targets (
    session_id, audience_revision, target_kind,
    target_identity_id, created_by_identity_id
)
SELECT '00000000-0000-4000-8000-000000006910'::uuid,
       1, 'user', viewer.id, initiator.id
FROM iam.identities viewer
CROSS JOIN iam.identities initiator
WHERE viewer.normalized_login_name ~ '^cast-viewer-[0-9]{2}-smoke$'
  AND initiator.normalized_login_name = 'cast-initiator-smoke';

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
    initiator_id uuid;
    viewer_id uuid;
    invitation_id uuid;
    grant_id uuid;
    current_index integer;
    downgrade record;
    sensitive_columns integer;
BEGIN
    SELECT id INTO initiator_id
    FROM iam.identities
    WHERE normalized_login_name = 'cast-initiator-smoke';

    IF NOT EXISTS (
        SELECT 1
        FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'system_admin'
          AND role_permission.permission_key = 'cast:manage'
    ) OR EXISTS (
        SELECT 1
        FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'system_admin'
          AND role_permission.permission_key = 'cast:view'
    ) OR NOT EXISTS (
        SELECT 1
        FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'member'
          AND role_permission.permission_key IN ('cast:use', 'cast:view')
        GROUP BY role.id
        HAVING count(*) = 2
    ) OR EXISTS (
        SELECT 1
        FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'member'
          AND role_permission.permission_key IN ('cast:share', 'cast:manage')
    ) THEN
        RAISE EXCEPTION 'casting permission separation is not canonical';
    END IF;

    INSERT INTO platform.cast_viewer_grants (
        session_id, audience_revision, viewer_identity_id,
        issued_by_identity_id, expires_at
    ) VALUES (
        '00000000-0000-4000-8000-000000006910'::uuid,
        1, initiator_id, initiator_id,
        clock_timestamp() + interval '4 minutes'
    ) RETURNING id INTO grant_id;

    UPDATE platform.cast_viewer_grants
    SET grant_state = 'joined', revision = 2, joined_at = clock_timestamp()
    WHERE id = grant_id;

    FOR current_index IN 1..8 LOOP
        SELECT id INTO viewer_id
        FROM iam.identities
        WHERE normalized_login_name = format(
            'cast-viewer-%s-smoke', lpad(current_index::text, 2, '0')
        );

        INSERT INTO platform.cast_viewer_invitations (
            session_id, audience_revision, invitee_identity_id,
            invited_by_identity_id, expires_at
        ) VALUES (
            '00000000-0000-4000-8000-000000006910'::uuid,
            1, viewer_id, initiator_id,
            clock_timestamp() + interval '10 minutes'
        ) RETURNING id INTO invitation_id;

        UPDATE platform.cast_viewer_invitations
        SET invitation_state = 'accepted', revision = 2,
            resolved_at = clock_timestamp()
        WHERE id = invitation_id;

        INSERT INTO platform.cast_viewer_grants (
            session_id, audience_revision, viewer_identity_id,
            invitation_id, issued_by_identity_id, expires_at
        ) VALUES (
            '00000000-0000-4000-8000-000000006910'::uuid,
            1, viewer_id, invitation_id, initiator_id,
            clock_timestamp() + interval '4 minutes'
        ) RETURNING id INTO grant_id;

        -- Resource admission belongs to the runtime. Migration 86 removed the
        -- old sample-count ceiling; a ninth authorized viewer is valid here.
        UPDATE platform.cast_viewer_grants
        SET grant_state = 'joined', revision = 2,
            joined_at = clock_timestamp()
        WHERE id = grant_id;
    END LOOP;

    SELECT id INTO viewer_id
    FROM iam.identities
    WHERE normalized_login_name = 'cast-viewer-09-smoke';

    INSERT INTO platform.cast_viewer_invitations (
        session_id, audience_revision, invitee_identity_id,
        invited_by_identity_id, expires_at
    ) VALUES (
        '00000000-0000-4000-8000-000000006910'::uuid,
        1, viewer_id, initiator_id,
        clock_timestamp() + interval '10 minutes'
    );

    IF (
        SELECT count(*)
        FROM platform.cast_viewer_grants
        WHERE session_id = '00000000-0000-4000-8000-000000006910'::uuid
          AND grant_state = 'joined'
    ) <> 9 THEN
        RAISE EXCEPTION 'authorized casting viewers were capped by a sample count';
    END IF;

    BEGIN
        INSERT INTO platform.cast_sessions (
            appliance_node_id, initiator_identity_id,
            output_sinks, browser_audience, expires_at
        ) VALUES (
            '00000000-0000-4000-8000-000000006901'::uuid,
            initiator_id, ARRAY['browser']::text[], 'owner_only',
            clock_timestamp() + interval '1 hour'
        );
        RAISE EXCEPTION 'second non-terminal casting session was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE platform.cast_sessions
        SET output_sinks = ARRAY['hdmi', 'browser']::text[], audience_revision = audience_revision + 1
        WHERE id = '00000000-0000-4000-8000-000000006910'::uuid;
        RAISE EXCEPTION 'casting output update enabled physical delivery';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    SELECT * INTO downgrade
    FROM platform.downgrade_cast_audience_to_owner(
        '00000000-0000-4000-8000-000000006910'::uuid,
        initiator_id,
        1
    );

    IF downgrade.new_audience_revision <> 2
       OR downgrade.revoked_target_count <> 9
       OR downgrade.revoked_invitation_count <> 1
       OR downgrade.revoked_viewer_count <> 8
       OR (SELECT browser_audience FROM platform.cast_sessions
           WHERE id = '00000000-0000-4000-8000-000000006910'::uuid) <> 'owner_only'
       OR EXISTS (
           SELECT 1 FROM platform.cast_audience_targets
           WHERE session_id = '00000000-0000-4000-8000-000000006910'::uuid
             AND target_state = 'active'
       )
       OR EXISTS (
           SELECT 1 FROM platform.cast_viewer_grants
           WHERE session_id = '00000000-0000-4000-8000-000000006910'::uuid
             AND viewer_identity_id <> initiator_id
             AND grant_state IN ('issued', 'joined')
       )
       OR NOT EXISTS (
           SELECT 1 FROM platform.cast_viewer_grants
           WHERE session_id = '00000000-0000-4000-8000-000000006910'::uuid
             AND viewer_identity_id = initiator_id
             AND grant_state = 'joined'
       ) THEN
        RAISE EXCEPTION 'atomic owner-only downgrade did not revoke the exact audience';
    END IF;

    BEGIN
        UPDATE platform.cast_session_events
        SET active_viewer_count = 0
        WHERE session_id = '00000000-0000-4000-8000-000000006910'::uuid;
        RAISE EXCEPTION 'append-only casting event was mutable';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        DELETE FROM platform.cast_sessions
        WHERE id = '00000000-0000-4000-8000-000000006910'::uuid;
        RAISE EXCEPTION 'durable casting session was deletable';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    SELECT count(*) INTO sensitive_columns
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name IN (
          'cast_sessions', 'cast_audience_targets',
          'cast_viewer_invitations', 'cast_viewer_grants',
          'cast_session_events'
      )
      AND column_name ~ '(pin|secret|token|credential|pairing_key|media_key|source_device|frame|audio|payload)';
    IF sensitive_columns <> 0 THEN
        RAISE EXCEPTION 'casting schema contains a prohibited durable secret/media column';
    END IF;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

UPDATE platform.cast_sessions
SET session_state = 'stopped',
    state_revision = state_revision + 1,
    terminal_at = clock_timestamp(),
    terminal_reason_code = 'user_stopped'
WHERE id = '00000000-0000-4000-8000-000000006910'::uuid;

INSERT INTO platform.cast_sessions (
    id, appliance_node_id, initiator_identity_id,
    output_sinks, browser_audience, expires_at
)
SELECT '00000000-0000-4000-8000-000000006920'::uuid,
       '00000000-0000-4000-8000-000000006901'::uuid,
       identity.id, ARRAY['browser']::text[], 'selected_team',
       clock_timestamp() + interval '1 hour'
FROM iam.identities identity
WHERE identity.normalized_login_name = 'cast-initiator-smoke';

INSERT INTO platform.cast_audience_targets (
    session_id, audience_revision, target_kind,
    target_team_id, created_by_identity_id
)
SELECT '00000000-0000-4000-8000-000000006920'::uuid,
       1, 'team', '00000000-0000-4000-8000-000000006902'::uuid,
       initiator.id
FROM iam.identities initiator
WHERE initiator.normalized_login_name = 'cast-initiator-smoke';

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
    initiator_id uuid;
    outsider_id uuid;
BEGIN
    SELECT id INTO initiator_id FROM iam.identities
    WHERE normalized_login_name = 'cast-initiator-smoke';
    SELECT id INTO outsider_id FROM iam.identities
    WHERE normalized_login_name = 'cast-outsider-smoke';

    IF NOT platform.cast_identity_in_current_audience(
        '00000000-0000-4000-8000-000000006920'::uuid,
        (SELECT id FROM iam.identities
         WHERE normalized_login_name = 'cast-viewer-01-smoke')
    ) THEN
        RAISE EXCEPTION 'current team audience membership was not honored';
    END IF;

    BEGIN
        INSERT INTO platform.cast_viewer_invitations (
            session_id, audience_revision, invitee_identity_id,
            invited_by_identity_id, expires_at
        ) VALUES (
            '00000000-0000-4000-8000-000000006920'::uuid,
            1, outsider_id, initiator_id,
            clock_timestamp() + interval '10 minutes'
        );
        RAISE EXCEPTION 'non-member casting invitation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

UPDATE platform.cast_sessions
SET session_state = 'stopped',
    state_revision = state_revision + 1,
    terminal_at = clock_timestamp(),
    terminal_reason_code = 'user_stopped'
WHERE id = '00000000-0000-4000-8000-000000006920'::uuid;

DO $$
DECLARE
    initiator_id uuid;
    use_only_id uuid;
    rejected_sinks text[];
BEGIN
    SELECT id INTO initiator_id FROM iam.identities
    WHERE normalized_login_name = 'cast-initiator-smoke';
    SELECT id INTO use_only_id FROM iam.identities
    WHERE normalized_login_name = 'cast-use-only-smoke';

    FOR rejected_sinks IN
        SELECT output_sinks FROM (VALUES
            (ARRAY['hdmi']::text[]),
            (ARRAY['hdmi', 'browser']::text[]),
            (ARRAY[]::text[]),
            (ARRAY['unknown']::text[])
        ) AS fixture(output_sinks)
    LOOP
        BEGIN
            INSERT INTO platform.cast_sessions (
                appliance_node_id, initiator_identity_id,
                output_sinks, browser_audience, expires_at
            ) VALUES (
                '00000000-0000-4000-8000-000000006901'::uuid,
                initiator_id, rejected_sinks, 'owner_only',
                clock_timestamp() + interval '1 hour'
            );
            SET CONSTRAINTS ALL IMMEDIATE;
            RAISE EXCEPTION 'non-browser casting output was accepted';
        EXCEPTION WHEN check_violation THEN
            SET CONSTRAINTS ALL DEFERRED;
        END;
    END LOOP;

    BEGIN
        INSERT INTO platform.cast_sessions (
            appliance_node_id, initiator_identity_id,
            output_sinks, browser_audience, expires_at
        ) VALUES (
            '00000000-0000-4000-8000-000000006901'::uuid,
            use_only_id, ARRAY['browser']::text[], 'owner_only',
            clock_timestamp() + interval '1 hour'
        );
        RAISE EXCEPTION 'casting creation without cast:view was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

-- Simulate a retained pre-105 row only inside this rolled-back fixture. Its
-- immutable output history must not prevent stopping the retired session.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE platform.cast_sessions DISABLE TRIGGER cast_sessions_write_guard;
INSERT INTO platform.cast_sessions (
    id, appliance_node_id, initiator_identity_id,
    output_sinks, browser_audience, expires_at
)
SELECT '00000000-0000-4000-8000-000000006930'::uuid,
       '00000000-0000-4000-8000-000000006901'::uuid,
       identity.id, ARRAY['hdmi', 'browser']::text[], 'owner_only',
       clock_timestamp() + interval '1 hour'
FROM iam.identities identity
WHERE identity.normalized_login_name = 'cast-initiator-smoke';
ALTER TABLE platform.cast_sessions ENABLE TRIGGER cast_sessions_write_guard;
UPDATE platform.cast_sessions
SET session_state = 'stopped', state_revision = state_revision + 1,
    terminal_at = clock_timestamp(), terminal_reason_code = 'legacy_retired'
WHERE id = '00000000-0000-4000-8000-000000006930'::uuid;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM platform.cast_sessions
        WHERE id = '00000000-0000-4000-8000-000000006930'::uuid
          AND session_state = 'stopped'
          AND output_sinks = ARRAY['hdmi', 'browser']::text[]
    ) THEN
        RAISE EXCEPTION 'legacy casting lifecycle or output history was changed';
    END IF;
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
