-- This migration introduces an enforceable admission marker and authoritative
-- bootstrap/orphan ledgers that the previous schema cannot represent.  A
-- downgrade is therefore safe only before any post-migration node or workflow
-- exists.  Refuse rather than deleting security evidence or silently turning
-- a post-migration node into a grandfathered legacy node.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM compute.node_bootstrap_coordinations)
       OR EXISTS (SELECT 1 FROM compute.node_bootstrap_orphans)
       OR EXISTS (SELECT 1 FROM compute.node_bootstrap_orphan_actions)
       OR EXISTS (SELECT 1 FROM compute.nodes WHERE bootstrap_admission_required) THEN
        RAISE EXCEPTION 'cannot downgrade managed-node bootstrap coordination: post-migration bootstrap state exists'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM compute.node_onboarding_transactions
        WHERE state NOT IN ('manual_recovery', 'cancelled')
        GROUP BY target_ip, ssh_port
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'cannot downgrade managed-node bootstrap coordination: historical ready target rows conflict with the legacy uniqueness contract'
            USING ERRCODE = '23505';
    END IF;
END
$$;

-- Restore the generic publisher function exactly as defined by migration 2.
CREATE OR REPLACE FUNCTION platform.claim_outbox(
    p_publisher text,
    p_batch_size integer DEFAULT 100,
    p_claim_seconds integer DEFAULT 30
)
RETURNS SETOF platform.outbox_events
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_publisher !~ '^[a-z][a-z0-9._-]{2,127}$' THEN
        RAISE EXCEPTION 'invalid publisher identifier';
    END IF;
    IF p_batch_size < 1 OR p_batch_size > 1000 THEN
        RAISE EXCEPTION 'batch size must be between 1 and 1000';
    END IF;
    IF p_claim_seconds < 5 OR p_claim_seconds > 600 THEN
        RAISE EXCEPTION 'claim seconds must be between 5 and 600';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT event_id
        FROM platform.outbox_events
        WHERE published_at IS NULL
          AND available_at <= clock_timestamp()
          AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
        ORDER BY available_at, occurred_at, event_id
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE platform.outbox_events AS event
    SET claimed_by = p_publisher,
        claim_token = uuidv7(),
        claimed_until = clock_timestamp() + make_interval(secs => p_claim_seconds),
        publish_attempts = event.publish_attempts + 1,
        last_error = NULL
    FROM candidates
    WHERE event.event_id = candidates.event_id
    RETURNING event.*;
END;
$$;

DROP TRIGGER IF EXISTS node_bootstrap_orphan_actions_append_only ON compute.node_bootstrap_orphan_actions;
DROP FUNCTION IF EXISTS compute.reject_node_bootstrap_orphan_action_mutation();
DROP TABLE IF EXISTS compute.node_bootstrap_orphan_actions;
DROP TRIGGER IF EXISTS node_bootstrap_orphans_append_only ON compute.node_bootstrap_orphans;
DROP FUNCTION IF EXISTS compute.reject_node_bootstrap_orphan_mutation();
DROP TABLE IF EXISTS compute.node_bootstrap_orphans;
DROP TABLE IF EXISTS compute.node_bootstrap_coordinations;
ALTER TABLE compute.nodes DROP COLUMN IF EXISTS bootstrap_admission_required;
DROP INDEX IF EXISTS compute.node_onboarding_one_active_target_idx;
CREATE UNIQUE INDEX node_onboarding_one_active_target_idx
ON compute.node_onboarding_transactions (target_ip, ssh_port)
WHERE state NOT IN ('manual_recovery', 'cancelled');
