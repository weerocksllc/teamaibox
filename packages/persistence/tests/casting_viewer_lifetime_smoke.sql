\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

-- Independent fixtures: never select an arbitrary existing user or appliance.
INSERT INTO compute.nodes (
    id, node_key, architecture, trust_kind, lifecycle_state, appliance_role
) VALUES (
    '00000000-0000-4000-8000-000000010301',
    'casting-lifetime-local-smoke', 'arm64', 'managed_appliance', 'ready', 'appliance-core'
);
INSERT INTO iam.identities (
    id, identity_kind, login_name, normalized_login_name, display_name, password_hash
) VALUES (
    '00000000-0000-4000-8000-000000010302', 'local_user',
    'casting-lifetime-smoke', 'casting-lifetime-smoke', 'Casting Lifetime Smoke',
    '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
);
INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key)
SELECT '00000000-0000-4000-8000-000000010302', id, 'team', 'team.default'
FROM iam.roles WHERE role_key='member';

DO $$
DECLARE actor uuid := '00000000-0000-4000-8000-000000010302';
    appliance_id uuid := '00000000-0000-4000-8000-000000010301';
    session_id uuid := uuidv7();
    grant_id uuid; boundary timestamptz := clock_timestamp()+interval '30 minutes';
BEGIN
    INSERT INTO platform.cast_sessions(id,appliance_node_id,initiator_identity_id,
        output_sinks,browser_audience,expires_at)
        VALUES(session_id,appliance_id,actor,ARRAY['browser'],'owner_only',boundary);
    INSERT INTO platform.cast_viewer_grants(session_id,audience_revision,viewer_identity_id,
        issued_by_identity_id,expires_at)
        VALUES(session_id,1,actor,actor,boundary) RETURNING id INTO grant_id;
    IF NOT EXISTS(SELECT 1 FROM platform.cast_viewer_grants WHERE id=grant_id
                  AND expires_at>issued_at+interval '5 minutes' AND expires_at=boundary) THEN
        RAISE EXCEPTION 'session-bounded viewer lifetime not persisted';
    END IF;
    -- The grant remains immutable and cannot be extended after issuance.
    BEGIN
        UPDATE platform.cast_viewer_grants SET expires_at=boundary+interval '1 minute',revision=revision+1 WHERE id=grant_id;
        RAISE EXCEPTION 'grant extension unexpectedly allowed';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A separately issued grant must still obey the parent boundary. The
    -- guard rejects it before the unique-open-grant index is reached.
    BEGIN
        INSERT INTO platform.cast_viewer_grants(session_id,audience_revision,viewer_identity_id,
            issued_by_identity_id,expires_at)
            VALUES(session_id,1,actor,actor,boundary+interval '1 second');
        RAISE EXCEPTION 'grant beyond session unexpectedly allowed';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO platform.cast_viewer_grants(session_id,audience_revision,viewer_identity_id,
            issued_by_identity_id,expires_at)
            VALUES(session_id,2,actor,actor,boundary);
        RAISE EXCEPTION 'stale audience unexpectedly allowed';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'viewer-lifetime: session boundary, immutable lifetime and audience checks passed';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
