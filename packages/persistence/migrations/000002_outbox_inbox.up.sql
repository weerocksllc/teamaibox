CREATE TABLE platform.outbox_events (
    event_id uuid PRIMARY KEY DEFAULT uuidv7(),
    subject text NOT NULL CHECK (
        subject ~ '^teamaibox\.(events|commands)\.v[0-9]+\.[a-z][a-z0-9._-]{1,190}$'
    ),
    event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9._-]{2,190}$'),
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9._-]{1,127}$'),
    aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 512),
    aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
    correlation_id uuid,
    causation_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_by text,
    claim_token uuid,
    claimed_until timestamptz,
    publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
    published_at timestamptz,
    broker_stream text,
    broker_sequence bigint CHECK (broker_sequence IS NULL OR broker_sequence > 0),
    last_error text,
    UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type),
    CHECK (
        (claimed_by IS NULL AND claim_token IS NULL AND claimed_until IS NULL)
        OR (claimed_by IS NOT NULL AND claim_token IS NOT NULL AND claimed_until IS NOT NULL)
    ),
    CHECK (
        published_at IS NULL
        OR (broker_stream IS NOT NULL AND broker_sequence IS NOT NULL)
    )
);

CREATE INDEX outbox_ready_idx
ON platform.outbox_events (available_at, occurred_at, event_id)
WHERE published_at IS NULL;

CREATE INDEX outbox_stale_claim_idx
ON platform.outbox_events (claimed_until)
WHERE published_at IS NULL AND claimed_until IS NOT NULL;

CREATE FUNCTION platform.enqueue_outbox(
    p_subject text,
    p_event_type text,
    p_aggregate_type text,
    p_aggregate_id text,
    p_aggregate_version bigint,
    p_payload jsonb,
    p_headers jsonb DEFAULT '{}'::jsonb,
    p_correlation_id uuid DEFAULT NULL,
    p_causation_id uuid DEFAULT NULL,
    p_available_at timestamptz DEFAULT clock_timestamp(),
    p_event_id uuid DEFAULT uuidv7()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    inserted_id uuid;
BEGIN
    INSERT INTO platform.outbox_events (
        event_id, subject, event_type, aggregate_type, aggregate_id,
        aggregate_version, payload, headers, correlation_id, causation_id,
        available_at
    ) VALUES (
        p_event_id, p_subject, p_event_type, p_aggregate_type, p_aggregate_id,
        p_aggregate_version, p_payload, p_headers, p_correlation_id,
        p_causation_id, p_available_at
    )
    RETURNING event_id INTO inserted_id;
    RETURN inserted_id;
END;
$$;

CREATE FUNCTION platform.claim_outbox(
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

CREATE FUNCTION platform.mark_outbox_published(
    p_event_id uuid,
    p_claim_token uuid,
    p_broker_stream text,
    p_broker_sequence bigint
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE platform.outbox_events
    SET published_at = clock_timestamp(),
        broker_stream = p_broker_stream,
        broker_sequence = p_broker_sequence,
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL,
        last_error = NULL
    WHERE event_id = p_event_id
      AND claim_token = p_claim_token
      AND published_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$$;

CREATE FUNCTION platform.release_outbox_claim(
    p_event_id uuid,
    p_claim_token uuid,
    p_error text,
    p_retry_seconds integer DEFAULT 5
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    affected integer;
BEGIN
    IF p_retry_seconds < 1 OR p_retry_seconds > 3600 THEN
        RAISE EXCEPTION 'retry seconds must be between 1 and 3600';
    END IF;
    UPDATE platform.outbox_events
    SET available_at = clock_timestamp() + make_interval(secs => p_retry_seconds),
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL,
        last_error = left(p_error, 2048)
    WHERE event_id = p_event_id
      AND claim_token = p_claim_token
      AND published_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$$;

CREATE TABLE platform.inbox_receipts (
    consumer_name text NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9._-]{2,127}$'),
    event_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9._-]{2,190}$'),
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    state text NOT NULL CHECK (state IN ('processing', 'processed', 'failed')),
    claim_token uuid,
    claimed_until timestamptz,
    delivery_count integer NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    last_error text,
    PRIMARY KEY (consumer_name, event_id),
    CHECK (
        (state = 'processing' AND claim_token IS NOT NULL AND claimed_until IS NOT NULL AND processed_at IS NULL)
        OR (state = 'processed' AND claim_token IS NULL AND claimed_until IS NULL AND processed_at IS NOT NULL)
        OR (state = 'failed' AND claim_token IS NULL AND claimed_until IS NULL AND processed_at IS NULL)
    )
);

CREATE INDEX inbox_processing_expiry_idx
ON platform.inbox_receipts (claimed_until)
WHERE state = 'processing';

CREATE INDEX inbox_processed_retention_idx
ON platform.inbox_receipts (processed_at)
WHERE state = 'processed';

CREATE TYPE platform.inbox_claim_outcome AS ENUM (
    'acquired',
    'busy',
    'processed',
    'payload_mismatch'
);

CREATE TYPE platform.inbox_claim_result AS (
    outcome platform.inbox_claim_outcome,
    claim_token uuid
);

CREATE FUNCTION platform.claim_inbox(
    p_consumer_name text,
    p_event_id uuid,
    p_event_type text,
    p_payload_sha256 bytea,
    p_claim_seconds integer DEFAULT 30
)
RETURNS platform.inbox_claim_result
LANGUAGE plpgsql
AS $$
DECLARE
    existing platform.inbox_receipts%ROWTYPE;
    new_token uuid;
    result platform.inbox_claim_result;
BEGIN
    IF p_consumer_name !~ '^[a-z][a-z0-9._-]{2,127}$' THEN
        RAISE EXCEPTION 'invalid consumer identifier';
    END IF;
    IF p_event_type !~ '^[a-z][a-z0-9._-]{2,190}$' THEN
        RAISE EXCEPTION 'invalid event type';
    END IF;
    IF octet_length(p_payload_sha256) <> 32 THEN
        RAISE EXCEPTION 'payload checksum must contain 32 bytes';
    END IF;
    IF p_claim_seconds < 5 OR p_claim_seconds > 600 THEN
        RAISE EXCEPTION 'claim seconds must be between 5 and 600';
    END IF;

    SELECT *
    INTO existing
    FROM platform.inbox_receipts
    WHERE consumer_name = p_consumer_name
      AND event_id = p_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        new_token := uuidv7();
        INSERT INTO platform.inbox_receipts (
            consumer_name, event_id, event_type, payload_sha256,
            state, claim_token, claimed_until
        ) VALUES (
            p_consumer_name, p_event_id, p_event_type, p_payload_sha256,
            'processing', new_token,
            clock_timestamp() + make_interval(secs => p_claim_seconds)
        );
        result.outcome := 'acquired';
        result.claim_token := new_token;
        RETURN result;
    END IF;

    UPDATE platform.inbox_receipts
    SET last_seen_at = clock_timestamp(),
        delivery_count = delivery_count + 1
    WHERE consumer_name = p_consumer_name
      AND event_id = p_event_id;

    IF existing.payload_sha256 <> p_payload_sha256
       OR existing.event_type <> p_event_type THEN
        result.outcome := 'payload_mismatch';
        result.claim_token := NULL;
        RETURN result;
    END IF;
    IF existing.state = 'processed' THEN
        result.outcome := 'processed';
        result.claim_token := NULL;
        RETURN result;
    END IF;
    IF existing.state = 'processing'
       AND existing.claimed_until >= clock_timestamp() THEN
        result.outcome := 'busy';
        result.claim_token := NULL;
        RETURN result;
    END IF;

    new_token := uuidv7();
    UPDATE platform.inbox_receipts
    SET state = 'processing',
        claim_token = new_token,
        claimed_until = clock_timestamp() + make_interval(secs => p_claim_seconds),
        processed_at = NULL,
        last_error = NULL
    WHERE consumer_name = p_consumer_name
      AND event_id = p_event_id;
    result.outcome := 'acquired';
    result.claim_token := new_token;
    RETURN result;
END;
$$;

CREATE FUNCTION platform.complete_inbox(
    p_consumer_name text,
    p_event_id uuid,
    p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE platform.inbox_receipts
    SET state = 'processed',
        claim_token = NULL,
        claimed_until = NULL,
        processed_at = clock_timestamp(),
        last_error = NULL
    WHERE consumer_name = p_consumer_name
      AND event_id = p_event_id
      AND state = 'processing'
      AND claim_token = p_claim_token;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$$;

CREATE FUNCTION platform.fail_inbox(
    p_consumer_name text,
    p_event_id uuid,
    p_claim_token uuid,
    p_error text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE platform.inbox_receipts
    SET state = 'failed',
        claim_token = NULL,
        claimed_until = NULL,
        processed_at = NULL,
        last_error = left(p_error, 2048)
    WHERE consumer_name = p_consumer_name
      AND event_id = p_event_id
      AND state = 'processing'
      AND claim_token = p_claim_token;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$$;

