DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.computer_operations WHERE action='installation')
      OR EXISTS (SELECT 1 FROM platform.computer_installations WHERE auto_start OR error_code IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot remove persisted installation operations';
    END IF;
END $$;
ALTER TABLE platform.computer_installations DROP COLUMN auto_start,DROP COLUMN error_code;
ALTER TABLE platform.computer_operations DROP CONSTRAINT computer_operations_action_check;
ALTER TABLE platform.computer_operations ADD CONSTRAINT computer_operations_action_check
    CHECK(action IN ('create','start','shutdown','delete'));
