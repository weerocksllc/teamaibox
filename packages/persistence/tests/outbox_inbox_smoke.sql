\set ON_ERROR_STOP on

BEGIN;
SELECT platform.enqueue_outbox(
    'teamaibox.events.v1.jobs.created',
    'jobs.created',
    'job',
    'rolled-back-job',
    1,
    '{"state":"queued"}'
);
ROLLBACK;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM platform.outbox_events
        WHERE aggregate_id = 'rolled-back-job'
    ) THEN
        RAISE EXCEPTION 'rolled-back business event remained in outbox';
    END IF;
END;
$$;

CREATE TEMP TABLE smoke_context (
    event_id uuid PRIMARY KEY,
    outbox_claim_token uuid,
    inbox_claim_token uuid
);

INSERT INTO smoke_context (event_id)
SELECT platform.enqueue_outbox(
    'teamaibox.events.v1.jobs.created',
    'jobs.created',
    'job',
    'committed-job',
    1,
    '{"state":"queued"}',
    '{"source":"smoke"}'
);

WITH claimed AS (
    SELECT * FROM platform.claim_outbox('publisher.smoke', 10, 30)
)
UPDATE smoke_context AS context
SET outbox_claim_token = claimed.claim_token
FROM claimed
WHERE context.event_id = claimed.event_id;

DO $$
DECLARE
    context smoke_context%ROWTYPE;
BEGIN
    SELECT * INTO context FROM smoke_context;
    IF context.outbox_claim_token IS NULL THEN
        RAISE EXCEPTION 'outbox event was not claimed';
    END IF;
    IF platform.mark_outbox_published(
        context.event_id,
        uuidv7(),
        'TAIB_EVENTS_V1',
        1
    ) THEN
        RAISE EXCEPTION 'wrong outbox claim token was accepted';
    END IF;
    IF NOT platform.mark_outbox_published(
        context.event_id,
        context.outbox_claim_token,
        'TAIB_EVENTS_V1',
        1
    ) THEN
        RAISE EXCEPTION 'valid outbox claim token was rejected';
    END IF;
END;
$$;

CREATE TEMP TABLE inbox_outcomes (
    sequence integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label text NOT NULL,
    outcome text NOT NULL,
    claim_token uuid
);

WITH context AS (
    SELECT event_id FROM smoke_context
), claim AS (
    SELECT platform.claim_inbox(
        'consumer.smoke',
        context.event_id,
        'jobs.created',
        decode(repeat('11', 32), 'hex'),
        30
    ) AS value
    FROM context
)
INSERT INTO inbox_outcomes (label, outcome, claim_token)
SELECT 'first', (value).outcome::text, (value).claim_token
FROM claim;

UPDATE smoke_context
SET inbox_claim_token = (
    SELECT claim_token FROM inbox_outcomes WHERE label = 'first'
);

WITH context AS (
    SELECT event_id FROM smoke_context
), claim AS (
    SELECT platform.claim_inbox(
        'consumer.smoke',
        context.event_id,
        'jobs.created',
        decode(repeat('11', 32), 'hex'),
        30
    ) AS value
    FROM context
)
INSERT INTO inbox_outcomes (label, outcome, claim_token)
SELECT 'busy', (value).outcome::text, (value).claim_token
FROM claim;

DO $$
DECLARE
    context smoke_context%ROWTYPE;
BEGIN
    SELECT * INTO context FROM smoke_context;
    IF (SELECT outcome FROM inbox_outcomes WHERE label = 'first') <> 'acquired' THEN
        RAISE EXCEPTION 'first inbox claim was not acquired';
    END IF;
    IF (SELECT outcome FROM inbox_outcomes WHERE label = 'busy') <> 'busy' THEN
        RAISE EXCEPTION 'active inbox claim did not report busy';
    END IF;
    IF NOT platform.complete_inbox(
        'consumer.smoke',
        context.event_id,
        context.inbox_claim_token
    ) THEN
        RAISE EXCEPTION 'valid inbox completion token was rejected';
    END IF;
END;
$$;

WITH context AS (
    SELECT event_id FROM smoke_context
), claim AS (
    SELECT platform.claim_inbox(
        'consumer.smoke',
        context.event_id,
        'jobs.created',
        decode(repeat('11', 32), 'hex'),
        30
    ) AS value
    FROM context
)
INSERT INTO inbox_outcomes (label, outcome, claim_token)
SELECT 'processed', (value).outcome::text, (value).claim_token
FROM claim;

WITH context AS (
    SELECT event_id FROM smoke_context
), claim AS (
    SELECT platform.claim_inbox(
        'consumer.smoke',
        context.event_id,
        'jobs.created',
        decode(repeat('12', 32), 'hex'),
        30
    ) AS value
    FROM context
)
INSERT INTO inbox_outcomes (label, outcome, claim_token)
SELECT 'mismatch', (value).outcome::text, (value).claim_token
FROM claim;

DO $$
DECLARE
    event uuid;
BEGIN
    SELECT event_id INTO event FROM smoke_context;
    IF (SELECT outcome FROM inbox_outcomes WHERE label = 'processed') <> 'processed' THEN
        RAISE EXCEPTION 'processed redelivery was not recognized';
    END IF;
    IF (SELECT outcome FROM inbox_outcomes WHERE label = 'mismatch') <> 'payload_mismatch' THEN
        RAISE EXCEPTION 'event ID payload reuse was not rejected';
    END IF;
    IF (
        SELECT delivery_count
        FROM platform.inbox_receipts
        WHERE consumer_name = 'consumer.smoke'
          AND event_id = event
    ) <> 4 THEN
        RAISE EXCEPTION 'inbox delivery count is incorrect';
    END IF;
END;
$$;

DELETE FROM platform.inbox_receipts
WHERE consumer_name = 'consumer.smoke';

DELETE FROM platform.outbox_events
WHERE aggregate_id = 'committed-job';

