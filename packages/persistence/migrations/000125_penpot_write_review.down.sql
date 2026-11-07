DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM design.editor_deliveries WHERE claimed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Unreviewed Penpot writes must be retained';
  END IF;
END $$;

DROP INDEX design.editor_delivery_one_unreviewed_write;
ALTER TABLE design.editor_deliveries
  DROP CONSTRAINT editor_delivery_review_claim,
  DROP COLUMN outcome_uncertain,
  DROP COLUMN review_workspace,
  DROP COLUMN review_id,
  DROP COLUMN claimed_at;
