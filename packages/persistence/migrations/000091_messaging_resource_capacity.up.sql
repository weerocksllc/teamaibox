-- Remove product caps without modifying existing conversations or messages.
ALTER TABLE platform.messaging_conversations
    DROP CONSTRAINT messaging_conversations_title_check,
    ADD CONSTRAINT messaging_conversations_title_check CHECK (title IS NULL OR length(title) >= 1);
ALTER TABLE platform.messaging_messages DROP CONSTRAINT messaging_messages_content_check;
ALTER TABLE platform.messaging_attachments
    DROP CONSTRAINT messaging_attachments_attachment_ordinal_check,
    ALTER COLUMN attachment_ordinal TYPE bigint,
    ADD CONSTRAINT messaging_attachments_attachment_ordinal_check CHECK (attachment_ordinal > 0);
ALTER TABLE platform.messaging_events
    DROP CONSTRAINT messaging_events_audience_identity_ids_check,
    ADD CONSTRAINT messaging_events_audience_identity_ids_check CHECK (cardinality(audience_identity_ids) >= 1);
