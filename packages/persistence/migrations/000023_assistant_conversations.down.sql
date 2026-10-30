DROP TABLE platform.assistant_events;
ALTER TABLE platform.assistant_runs DROP CONSTRAINT assistant_runs_assistant_message_fk;
ALTER TABLE platform.assistant_runs DROP CONSTRAINT assistant_runs_user_message_fk;
DROP TABLE platform.assistant_messages;
DROP TABLE platform.assistant_runs;
DROP TABLE platform.assistant_conversations;
