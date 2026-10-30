DROP FUNCTION platform.fail_inbox(text, uuid, uuid, text);
DROP FUNCTION platform.complete_inbox(text, uuid, uuid);
DROP FUNCTION platform.claim_inbox(text, uuid, text, bytea, integer);
DROP TYPE platform.inbox_claim_result;
DROP TYPE platform.inbox_claim_outcome;
DROP TABLE platform.inbox_receipts;
DROP FUNCTION platform.release_outbox_claim(uuid, uuid, text, integer);
DROP FUNCTION platform.mark_outbox_published(uuid, uuid, text, bigint);
DROP FUNCTION platform.claim_outbox(text, integer, integer);
DROP FUNCTION platform.enqueue_outbox(text, text, text, text, bigint, jsonb, jsonb, uuid, uuid, timestamptz, uuid);
DROP TABLE platform.outbox_events;

