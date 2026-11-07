ALTER TABLE design.editor_deliveries
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN review_id uuid UNIQUE,
  ADD COLUMN review_workspace jsonb,
  ADD COLUMN outcome_uncertain boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT editor_delivery_review_claim CHECK (
    (claimed_at IS NULL AND review_id IS NULL AND review_workspace IS NULL AND NOT outcome_uncertain)
    OR (claimed_at IS NOT NULL AND review_id IS NOT NULL AND review_workspace IS NOT NULL
        AND jsonb_typeof(review_workspace) = 'object')
  );

-- A newly generated call ID cannot bypass an unreviewed write. No generated
-- code, result, native cookie, or replayable command is retained.
CREATE UNIQUE INDEX editor_delivery_one_unreviewed_write
  ON design.editor_deliveries ((binding->>'identityId')) WHERE claimed_at IS NOT NULL;
