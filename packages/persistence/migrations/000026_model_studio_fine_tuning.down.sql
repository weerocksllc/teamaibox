DROP INDEX IF EXISTS compute.fine_tuning_one_pending_promotion_idx;
DROP TABLE IF EXISTS compute.fine_tuning_promotion_requests;
DROP TABLE IF EXISTS compute.fine_tuning_candidates;
DROP TRIGGER IF EXISTS fine_tuning_experiments_touch_updated_at ON compute.fine_tuning_experiments;
DROP TABLE IF EXISTS compute.fine_tuning_experiments;
DROP TABLE IF EXISTS compute.fine_tuning_datasets;
