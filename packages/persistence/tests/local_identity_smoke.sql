\set ON_ERROR_STOP on
BEGIN;

WITH owner AS (
    INSERT INTO iam.identities (
        identity_kind,
        login_name,
        normalized_login_name,
        display_name,
        password_hash
    ) VALUES (
        'local_user',
        'owner-smoke',
        'owner-smoke',
        'Owner Smoke',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id, password_version
), owner_role AS (
    INSERT INTO iam.roles (role_key, display_name_key, description_key, system_role)
    VALUES ('owner-smoke', 'roles.owner.name', 'roles.owner.description', true)
    RETURNING id
), grant_role AS (
    INSERT INTO iam.identity_roles (identity_id, role_id)
    SELECT owner.id, owner_role.id FROM owner, owner_role
), bootstrap AS (
    INSERT INTO iam.appliance_bootstrap (owner_identity_id)
    SELECT id FROM owner
), auth_state AS (
    INSERT INTO iam.authentication_states (identity_id)
    SELECT id FROM owner
), session AS (
    INSERT INTO iam.sessions (
        identity_id,
        token_hash,
        csrf_hash,
        password_version,
        user_agent_hash,
        network_hash,
        idle_expires_at,
        expires_at
    )
    SELECT
        id,
        decode(repeat('11', 32), 'hex'),
        decode(repeat('22', 32), 'hex'),
        password_version,
        decode(repeat('33', 32), 'hex'),
        decode(repeat('44', 32), 'hex'),
        clock_timestamp() + interval '30 minutes',
        clock_timestamp() + interval '12 hours'
    FROM owner
), recovery AS (
    INSERT INTO iam.owner_recovery_codes (identity_id, code_hash, generation)
    SELECT id, decode(repeat('55', 32), 'hex'), 1 FROM owner
)
INSERT INTO iam.login_rate_limits (
    network_hash,
    failed_attempts,
    window_started_at,
    blocked_until,
    last_failed_at
) VALUES (
    decode(repeat('44', 32), 'hex'),
    20,
    clock_timestamp(),
    clock_timestamp() + interval '15 minutes',
    clock_timestamp()
);

DO $$
BEGIN
    IF (SELECT count(*) FROM iam.appliance_bootstrap) <> 1 THEN
        RAISE EXCEPTION 'owner bootstrap was not persisted';
    END IF;
    IF (SELECT count(*) FROM iam.sessions WHERE revoked_at IS NULL) <> 1 THEN
        RAISE EXCEPTION 'active session was not persisted';
    END IF;
    IF (SELECT count(*) FROM iam.owner_recovery_codes WHERE used_at IS NULL AND invalidated_at IS NULL) <> 1 THEN
        RAISE EXCEPTION 'active recovery code was not persisted';
    END IF;
    IF (SELECT failed_attempts FROM iam.login_rate_limits) <> 20 THEN
        RAISE EXCEPTION 'network throttle was not persisted';
    END IF;

    UPDATE iam.identities SET preferred_locale = 'en'
    WHERE normalized_login_name = 'owner-smoke';
    IF (SELECT preferred_locale FROM iam.identities WHERE normalized_login_name = 'owner-smoke') <> 'en' THEN
        RAISE EXCEPTION 'account locale preference was not persisted';
    END IF;

    BEGIN
        UPDATE iam.identities SET preferred_locale = 'zz-ZZ'
        WHERE normalized_login_name = 'owner-smoke';
        RAISE EXCEPTION 'expected unsupported locale rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE iam.identities SET preferred_theme = 'dark'
    WHERE normalized_login_name = 'owner-smoke';
    IF (SELECT preferred_theme FROM iam.identities WHERE normalized_login_name = 'owner-smoke') <> 'dark' THEN
        RAISE EXCEPTION 'account theme preference was not persisted';
    END IF;

    BEGIN
        UPDATE iam.identities SET preferred_theme = 'contrast'
        WHERE normalized_login_name = 'owner-smoke';
        RAISE EXCEPTION 'expected unsupported theme rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.appliance_bootstrap (owner_identity_id)
        SELECT owner_identity_id FROM iam.appliance_bootstrap;
        RAISE EXCEPTION 'expected singleton bootstrap rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.sessions (
            identity_id, token_hash, csrf_hash, password_version,
            user_agent_hash, network_hash, idle_expires_at, expires_at
        )
        SELECT
            identity_id,
            token_hash,
            decode(repeat('66', 32), 'hex'),
            password_version,
            user_agent_hash,
            network_hash,
            clock_timestamp() + interval '30 minutes',
            clock_timestamp() + interval '12 hours'
        FROM iam.sessions LIMIT 1;
        RAISE EXCEPTION 'expected duplicate session token rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
