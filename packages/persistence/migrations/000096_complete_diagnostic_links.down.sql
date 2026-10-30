-- Refuse downgrade rather than truncate existing relationships or identifiers.
ALTER TABLE platform.diagnostic_signals ADD CONSTRAINT diagnostic_signals_job_ids_check CHECK (cardinality(job_ids) <= 256);
ALTER TABLE platform.diagnostic_signals ADD CONSTRAINT diagnostic_signals_attempt_ids_check CHECK (cardinality(attempt_ids) <= 256);
ALTER TABLE platform.operational_alerts ADD CONSTRAINT operational_alerts_signal_ids_check CHECK (cardinality(signal_ids) <= 256);
ALTER TABLE platform.operational_alerts ADD CONSTRAINT operational_alerts_job_ids_check CHECK (cardinality(job_ids) <= 256);
ALTER TABLE compute.external_attempt_dispatches DROP CONSTRAINT external_attempt_dispatches_provider_request_id_check;
ALTER TABLE compute.external_attempt_dispatches ADD CONSTRAINT external_attempt_dispatches_provider_request_id_check
  CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256);
