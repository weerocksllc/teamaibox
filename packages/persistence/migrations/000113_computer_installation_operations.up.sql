-- Installation commands share the existing per-computer durable queue. No new
-- daemon or alternate locking/admission mechanism is introduced.
ALTER TABLE platform.computer_operations DROP CONSTRAINT computer_operations_action_check;
ALTER TABLE platform.computer_operations ADD CONSTRAINT computer_operations_action_check
    CHECK(action IN ('create','start','shutdown','delete','installation'));
ALTER TABLE platform.computer_installations ADD COLUMN auto_start boolean NOT NULL DEFAULT false;
ALTER TABLE platform.computer_installations ADD COLUMN error_code text;
