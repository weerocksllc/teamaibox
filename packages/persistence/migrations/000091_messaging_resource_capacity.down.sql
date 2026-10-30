-- An incompatible downgrade fails rather than trimming or deleting user data.
ALTER TABLE platform.messaging_conversations
    DROP CONSTRAINT messaging_conversations_title_check,
    ADD CONSTRAINT messaging_conversations_title_check CHECK (title IS NULL OR length(title) BETWEEN 1 AND 160);
ALTER TABLE platform.messaging_messages ADD CONSTRAINT messaging_messages_content_check CHECK (length(content) <= 32000);
ALTER TABLE platform.messaging_attachments
    DROP CONSTRAINT messaging_attachments_attachment_ordinal_check,
    ALTER COLUMN attachment_ordinal TYPE smallint,
    ADD CONSTRAINT messaging_attachments_attachment_ordinal_check CHECK (attachment_ordinal BETWEEN 1 AND 16);
ALTER TABLE platform.messaging_events
    DROP CONSTRAINT messaging_events_audience_identity_ids_check,
    ADD CONSTRAINT messaging_events_audience_identity_ids_check CHECK (cardinality(audience_identity_ids) BETWEEN 1 AND 500);
