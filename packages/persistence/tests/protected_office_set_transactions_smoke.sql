\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.nodes (
    id, node_key, architecture, trust_kind, lifecycle_state,
    appliance_role, desired_state,
    desired_state_revision, observed_state_revision,
    maintenance_generation, recovery_state
) VALUES (
    '00000000-0000-4000-8000-000000007011'::uuid,
    'protected-office-set-node-smoke', 'arm64', 'managed_appliance', 'ready',
    'appliance-core', '{}'::jsonb, 4, 4, 7, 'healthy'
);

INSERT INTO compute.protected_office_set_transactions (
    id, set_id, node_id, desired_state_revision, maintenance_generation,
    transaction_state, manifest, previous_identities,
    maintenance_authorization, admission, created_at, updated_at
) VALUES (
    'protected-office-smoke-tx-01',
    'office.baseline.smoke',
    '00000000-0000-4000-8000-000000007011'::uuid,
    4, 7, 'admitting',
    jsonb_build_object(
        'setId', 'office.baseline.smoke',
        'nodeId', '00000000-0000-4000-8000-000000007011',
        'desiredStateRevision', 4,
        'maintenanceGeneration', 7,
        'profiles', jsonb_build_array(
            jsonb_build_object(
                'modelProfileId', 'office.embedding',
                'workerId', 'office.embedding',
                'imageDigest', 'sha256:' || repeat('a', 64),
                'configurationDigest', 'sha256:' || repeat('b', 64),
                'placementClass', 'protected-resident',
                'maintenanceGeneration', 7,
                'declaredResidentBytes', 8589934592,
                'dependsOnWorkerIds', '[]'::jsonb,
                'stageOrder', 1
            ),
            jsonb_build_object(
                'modelProfileId', 'office.assistant',
                'workerId', 'office.assistant',
                'imageDigest', 'sha256:' || repeat('c', 64),
                'configurationDigest', 'sha256:' || repeat('d', 64),
                'placementClass', 'protected-resident',
                'maintenanceGeneration', 7,
                'declaredResidentBytes', 21474836480,
                'dependsOnWorkerIds', '["office.embedding"]'::jsonb,
                'stageOrder', 2
            )
        ),
        'requiredModelProfileIds', '["office.assistant","office.embedding"]'::jsonb,
        'declaredResidentBytes', 30064771072
    ),
    jsonb_build_object(
        'office.embedding', NULL,
        'office.assistant', jsonb_build_object(
            'workerId', 'office.assistant',
            'modelProfileId', 'office.assistant.previous',
            'imageDigest', 'sha256:' || repeat('e', 64),
            'configurationDigest', 'sha256:' || repeat('f', 64),
            'placementClass', 'protected-resident',
            'maintenanceGeneration', 7,
            'state', 'running', 'healthy', true,
            'residentBytes', 19327352832
        )
    ),
    jsonb_build_object(
        'transactionId', 'protected-office-smoke-tx-01',
        'workerIds', '["office.assistant"]'::jsonb,
        'allowedOperations', '["protected-set.maintenance"]'::jsonb,
        'maintenanceGeneration', 7,
        'issuedAt', '2026-09-04T08:00:00.000Z',
        'expiresAt', '2026-09-04T08:10:00.000Z'
    ),
    '{"incrementalBytes":30064771072,"requiredTotalBytes":81604378624}'::jsonb,
    '2026-09-04T08:00:00.000Z'::timestamptz,
    '2026-09-04T08:00:00.000Z'::timestamptz
);

INSERT INTO compute.protected_office_sets (
    set_id, node_id, desired_state_revision, observed_state_revision,
    maintenance_generation, recovery_state, recovery_reason_code,
    healthy_identities, aggregate_resident_bytes, last_transaction_id,
    created_at, updated_at
) VALUES (
    'office.baseline.smoke',
    '00000000-0000-4000-8000-000000007011'::uuid,
    4, 0, 7, 'recovering', 'protected_set_staging',
    '[]'::jsonb, 0, 'protected-office-smoke-tx-01',
    '2026-09-04T08:00:00.000Z'::timestamptz,
    '2026-09-04T08:00:00.000Z'::timestamptz
);

DO $$
BEGIN
    BEGIN
        INSERT INTO compute.protected_office_set_transactions (
            id, set_id, node_id, desired_state_revision,
            maintenance_generation, transaction_state, manifest,
            previous_identities, admission
        )
        SELECT 'protected-office-smoke-tx-02', set_id, node_id,
               desired_state_revision, maintenance_generation, 'admitting',
               manifest, previous_identities, admission
        FROM compute.protected_office_set_transactions
        WHERE id = 'protected-office-smoke-tx-01';
        RAISE EXCEPTION 'second active protected office transaction was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END;
$$;

UPDATE compute.protected_office_set_transactions
SET transaction_state = 'staging', revision = 2,
    steps = '[{"workerId":"office.embedding","state":"staging"}]'::jsonb,
    updated_at = '2026-09-04T08:00:01.000Z'::timestamptz
WHERE id = 'protected-office-smoke-tx-01' AND revision = 1;

DO $$
BEGIN
    BEGIN
        UPDATE compute.protected_office_set_transactions
        SET revision = 3,
            steps = '[{"workerId":"outside.manifest","state":"staging"}]'::jsonb,
            updated_at = '2026-09-04T08:00:02.000Z'::timestamptz
        WHERE id = 'protected-office-smoke-tx-01' AND revision = 2;
        RAISE EXCEPTION 'stage outside exact manifest was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE compute.protected_office_set_transactions
        SET revision = 3,
            manifest = jsonb_set(manifest, '{maintenanceGeneration}', '8'::jsonb),
            updated_at = '2026-09-04T08:00:02.000Z'::timestamptz
        WHERE id = 'protected-office-smoke-tx-01' AND revision = 2;
        RAISE EXCEPTION 'immutable protected office manifest was rewritten';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

UPDATE compute.protected_office_set_transactions
SET transaction_state = 'probing', revision = 3,
    steps = '[{"workerId":"office.embedding","state":"staged"}]'::jsonb,
    updated_at = '2026-09-04T08:00:03.000Z'::timestamptz
WHERE id = 'protected-office-smoke-tx-01' AND revision = 2;

UPDATE compute.protected_office_set_transactions
SET transaction_state = 'succeeded', revision = 4,
    steps = jsonb_build_array(
        jsonb_build_object(
            'workerId', 'office.embedding', 'state', 'healthy',
            'identity', jsonb_build_object(
                'workerId', 'office.embedding',
                'modelProfileId', 'office.embedding',
                'imageDigest', 'sha256:' || repeat('a', 64),
                'configurationDigest', 'sha256:' || repeat('b', 64),
                'placementClass', 'protected-resident',
                'maintenanceGeneration', 7,
                'state', 'running', 'healthy', true,
                'residentBytes', 7516192768
            )
        )
    ),
    observed_identities = jsonb_build_array(
        jsonb_build_object(
            'workerId', 'office.embedding',
            'modelProfileId', 'office.embedding',
            'imageDigest', 'sha256:' || repeat('a', 64),
            'configurationDigest', 'sha256:' || repeat('b', 64),
            'placementClass', 'protected-resident',
            'maintenanceGeneration', 7,
            'state', 'running', 'healthy', true,
            'residentBytes', 7516192768
        ),
        jsonb_build_object(
            'workerId', 'office.assistant',
            'modelProfileId', 'office.assistant',
            'imageDigest', 'sha256:' || repeat('c', 64),
            'configurationDigest', 'sha256:' || repeat('d', 64),
            'placementClass', 'protected-resident',
            'maintenanceGeneration', 7,
            'state', 'running', 'healthy', true,
            'residentBytes', 20401094656
        )
    ),
    updated_at = '2026-09-04T08:00:04.000Z'::timestamptz,
    completed_at = '2026-09-04T08:00:04.000Z'::timestamptz
WHERE id = 'protected-office-smoke-tx-01' AND revision = 3;

UPDATE compute.protected_office_sets protected_set
SET revision = 2, observed_state_revision = 4,
    recovery_state = 'healthy', recovery_reason_code = NULL,
    healthy_identities = journal.observed_identities,
    aggregate_resident_bytes = 27917287424,
    updated_at = '2026-09-04T08:00:04.000Z'::timestamptz
FROM compute.protected_office_set_transactions journal
WHERE protected_set.set_id = 'office.baseline.smoke'
  AND protected_set.revision = 1
  AND journal.id = protected_set.last_transaction_id;

DO $$
BEGIN
    BEGIN
        UPDATE compute.protected_office_set_transactions
        SET revision = 5,
            updated_at = '2026-09-04T08:00:05.000Z'::timestamptz
        WHERE id = 'protected-office-smoke-tx-01';
        RAISE EXCEPTION 'terminal protected office transaction was rewritten';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE compute.protected_office_sets
        SET revision = 3, aggregate_resident_bytes = 1,
            updated_at = '2026-09-04T08:00:05.000Z'::timestamptz
        WHERE set_id = 'office.baseline.smoke';
        RAISE EXCEPTION 'terminal protected office set projection was rewritten';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        DELETE FROM compute.protected_office_set_transactions
        WHERE id = 'protected-office-smoke-tx-01';
        RAISE EXCEPTION 'protected office transaction journal was deleted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM compute.protected_office_sets protected_set
        JOIN compute.protected_office_set_transactions journal
          ON journal.id = protected_set.last_transaction_id
        WHERE protected_set.set_id = 'office.baseline.smoke'
          AND protected_set.revision = 2
          AND protected_set.recovery_state = 'healthy'
          AND protected_set.observed_state_revision = 4
          AND protected_set.aggregate_resident_bytes = 27917287424
          AND journal.revision = 4
          AND journal.transaction_state = 'succeeded'
          AND jsonb_array_length(journal.steps) = 1
          AND jsonb_array_length(journal.observed_identities) = 2
    ) THEN
        RAISE EXCEPTION 'protected office transaction projection did not persist';
    END IF;
END;
$$;

-- A terminal journal releases the per-set transaction fence.
INSERT INTO compute.protected_office_set_transactions (
    id, set_id, node_id, desired_state_revision, maintenance_generation,
    transaction_state, manifest, previous_identities, admission
)
SELECT 'protected-office-smoke-tx-03', set_id, node_id,
       desired_state_revision, maintenance_generation, 'admitting',
       manifest, jsonb_build_object(
           'office.embedding', observed_identities->0,
           'office.assistant', observed_identities->1
       ), admission
FROM compute.protected_office_set_transactions
WHERE id = 'protected-office-smoke-tx-01';

ROLLBACK;
