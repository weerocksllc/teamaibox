ALTER TABLE platform.messaging_participants
  ADD COLUMN cleared_through_sequence bigint NOT NULL DEFAULT 0 CHECK (cleared_through_sequence >= 0),
  ADD COLUMN removed_through_sequence bigint CHECK (removed_through_sequence >= 0);

CREATE TABLE platform.messaging_hidden_messages (
  message_id uuid NOT NULL REFERENCES platform.messaging_messages(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (message_id, identity_id)
);
ALTER TABLE platform.messaging_events DROP CONSTRAINT messaging_events_event_type_check;
ALTER TABLE platform.messaging_events ADD CONSTRAINT messaging_events_event_type_check
  CHECK (event_type IN ('conversation.created','conversation.participant_added','conversation.participant_removed','message.created','message.edited','message.deleted','message.delivered','message.read','conversation.cleaned'));
