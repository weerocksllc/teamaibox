\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.nodes (
    node_key, architecture, trust_kind, lifecycle_state
) VALUES
    ('storage-source-node', 'aarch64', 'managed_appliance', 'ready'),
    ('storage-target-node', 'aarch64', 'managed_appliance', 'ready'),
    ('storage-peer-node', 'aarch64', 'managed_appliance', 'ready');

INSERT INTO objects.storage_pools (
    pool_id, display_name, backend_kind, node_id, failure_domain,
    health_state, total_bytes, available_bytes, safety_reserve_bytes,
    encryption_mode, encryption_status, encryption_verified_at,
    compatibility_status, compatibility_verified_at, observed_at
)
SELECT 'storage-source', 'Storage Source', 'local-block', node.id, 'spark-source',
       'healthy', 1048576, 1048576, 65536,
       'luks2', 'verified', clock_timestamp(),
       'verified', clock_timestamp(), clock_timestamp()
FROM compute.nodes node WHERE node.node_key = 'storage-source-node'
UNION ALL
SELECT 'storage-target', 'Storage Target', 'local-filesystem', node.id, 'spark-target',
       'healthy', 1048576, 1048576, 65536,
       'luks2', 'verified', clock_timestamp(),
       'verified', clock_timestamp(), clock_timestamp()
FROM compute.nodes node WHERE node.node_key = 'storage-target-node'
UNION ALL
SELECT 'storage-peer', 'Storage Same Domain Peer', 'local-block', node.id, 'spark-source',
       'healthy', 1048576, 1048576, 65536,
       'luks2', 'verified', clock_timestamp(),
       'verified', clock_timestamp(), clock_timestamp()
FROM compute.nodes node WHERE node.node_key = 'storage-peer-node';

INSERT INTO objects.storage_pools (
    pool_id, display_name, backend_kind, failure_domain,
    health_state, total_bytes, available_bytes,
    encryption_mode, encryption_status,
    compatibility_status, compatibility_verified_at, observed_at
) VALUES (
    'storage-unsafe', 'Unencrypted Object Pool', 's3-compatible', 'provider-unsafe',
    'healthy', 1048576, 1048576,
    'none', 'pending', 'verified', clock_timestamp(), clock_timestamp()
);

INSERT INTO objects.storage_pool_data_classes (pool_id, data_class)
VALUES
    ('storage-source', 'team-file'),
    ('storage-target', 'team-file'),
    ('storage-peer', 'team-file'),
    ('storage-unsafe', 'team-file');

INSERT INTO objects.encrypted_blobs (
    blob_key, plaintext_size, plaintext_sha256, ciphertext_size, ciphertext_sha256,
    data_algorithm, data_nonce, data_tag, wrap_algorithm, wrapping_key_version,
    wrap_nonce, wrapped_data_key, wrap_tag
) VALUES (
    'objects/storage-pool-smoke', 128, decode(repeat('15', 32), 'hex'),
    128, decode(repeat('25', 32), 'hex'), 'aes-256-gcm',
    decode(repeat('35', 12), 'hex'), decode(repeat('45', 16), 'hex'),
    'aes-256-gcm-keywrap', 1, decode(repeat('55', 12), 'hex'),
    decode(repeat('65', 32), 'hex'), decode(repeat('75', 16), 'hex')
);

DO $$
DECLARE
    unsafe_reservation uuid;
    domain_reservation uuid;
    source_reservation uuid;
    migration uuid;
BEGIN
    INSERT INTO objects.storage_placement_reservations (
        blob_key, data_class, size, sha256, requested_copies, expires_at
    ) VALUES (
        'objects/storage-pool-smoke', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 1, clock_timestamp() + interval '5 minutes'
    ) RETURNING reservation_id INTO unsafe_reservation;
    BEGIN
        INSERT INTO objects.storage_placement_targets (
            reservation_id, pool_id, allocation_kind
        ) VALUES (unsafe_reservation, 'storage-unsafe', 'primary');
        RAISE EXCEPTION 'expected unencrypted storage target rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    UPDATE objects.storage_placement_reservations
    SET state = 'aborted'
    WHERE reservation_id = unsafe_reservation;

    INSERT INTO objects.storage_placement_reservations (
        blob_key, data_class, size, sha256, requested_copies, expires_at
    ) VALUES (
        'objects/storage-pool-smoke', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 2, clock_timestamp() + interval '5 minutes'
    ) RETURNING reservation_id INTO domain_reservation;
    INSERT INTO objects.storage_placement_targets (
        reservation_id, pool_id, allocation_kind
    ) VALUES (domain_reservation, 'storage-source', 'primary');
    BEGIN
        INSERT INTO objects.storage_placement_targets (
            reservation_id, pool_id, allocation_kind
        ) VALUES (domain_reservation, 'storage-peer', 'availability-copy');
        RAISE EXCEPTION 'expected same failure-domain rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    UPDATE objects.storage_placement_reservations
    SET state = 'aborted'
    WHERE reservation_id = domain_reservation;

    INSERT INTO objects.storage_placement_reservations (
        blob_key, data_class, size, sha256, requested_copies, expires_at
    ) VALUES (
        'objects/storage-pool-smoke', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 1, clock_timestamp() + interval '5 minutes'
    ) RETURNING reservation_id INTO source_reservation;
    INSERT INTO objects.storage_placement_targets (
        reservation_id, pool_id, allocation_kind
    ) VALUES (source_reservation, 'storage-source', 'primary');

    BEGIN
        UPDATE objects.storage_placement_reservations
        SET state = 'committed', committed_at = clock_timestamp()
        WHERE reservation_id = source_reservation;
        RAISE EXCEPTION 'expected unverified reservation commit rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO objects.storage_allocations (
            blob_key, pool_id, data_class, size, sha256,
            allocation_kind, verified_at
        ) VALUES (
            'objects/storage-pool-smoke', 'storage-source', 'team-file', 128,
            decode(repeat('ff', 32), 'hex'), 'primary', clock_timestamp()
        );
        RAISE EXCEPTION 'expected allocation integrity rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO objects.storage_allocations (
        blob_key, pool_id, data_class, size, sha256,
        allocation_kind, verified_at
    ) VALUES (
        'objects/storage-pool-smoke', 'storage-source', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 'primary', clock_timestamp()
    );
    UPDATE objects.storage_placement_reservations
    SET state = 'committed', committed_at = clock_timestamp()
    WHERE reservation_id = source_reservation;

    UPDATE objects.storage_pools
    SET lifecycle_state = 'draining'
    WHERE pool_id = 'storage-source';
    BEGIN
        UPDATE objects.storage_pools
        SET lifecycle_state = 'drained'
        WHERE pool_id = 'storage-source';
        RAISE EXCEPTION 'expected live allocation to block drained state';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO objects.storage_allocations (
            blob_key, pool_id, data_class, size, sha256,
            allocation_kind, verified_at
        ) VALUES (
            'objects/storage-pool-smoke', 'storage-target', 'team-file', 128,
            decode(repeat('15', 32), 'hex'), 'availability-copy', clock_timestamp()
        );
        RAISE EXCEPTION 'expected allocation without migration reservation rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO objects.storage_migrations (
        blob_key, data_class, size, sha256, source_pool_id, target_pool_id, state
    ) VALUES (
        'objects/storage-pool-smoke', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 'storage-source', 'storage-target', 'copying'
    ) RETURNING migration_id INTO migration;
    INSERT INTO objects.storage_allocations (
        blob_key, pool_id, data_class, size, sha256,
        allocation_kind, verified_at
    ) VALUES (
        'objects/storage-pool-smoke', 'storage-target', 'team-file', 128,
        decode(repeat('15', 32), 'hex'), 'availability-copy', clock_timestamp()
    );

    BEGIN
        UPDATE objects.storage_migrations
        SET state = 'completed', verified_at = clock_timestamp(),
            completed_at = clock_timestamp()
        WHERE migration_id = migration;
        RAISE EXCEPTION 'expected source allocation to block migration completion';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    UPDATE objects.storage_migrations
    SET state = 'cleanup_pending', verified_at = clock_timestamp()
    WHERE migration_id = migration;
    DELETE FROM objects.storage_allocations
    WHERE blob_key = 'objects/storage-pool-smoke' AND pool_id = 'storage-source';
    UPDATE objects.storage_migrations
    SET state = 'completed', completed_at = clock_timestamp()
    WHERE migration_id = migration;

    UPDATE objects.storage_pools
    SET lifecycle_state = 'drained'
    WHERE pool_id = 'storage-source';
    UPDATE objects.storage_pools
    SET lifecycle_state = 'removed', removed_at = clock_timestamp()
    WHERE pool_id = 'storage-source';
    IF (SELECT lifecycle_state FROM objects.storage_pools
        WHERE pool_id = 'storage-source') <> 'removed' THEN
        RAISE EXCEPTION 'storage pool was not safely removed';
    END IF;
    IF (SELECT count(*) FROM objects.storage_allocations
        WHERE blob_key = 'objects/storage-pool-smoke') <> 1 THEN
        RAISE EXCEPTION 'verified target allocation was not preserved';
    END IF;
END;
$$;

ROLLBACK;
