DROP TABLE platform.messaging_hidden_messages;
ALTER TABLE platform.messaging_participants
  DROP COLUMN removed_through_sequence,
  DROP COLUMN cleared_through_sequence;
-- Keep the expanded event constraint: existing cleanup audit events remain valid.
