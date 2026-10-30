-- Preserve complete identifiers and relationships; do not silently discard data.
ALTER TABLE platform.diagnostic_signals DROP CONSTRAINT diagnostic_signals_job_ids_check;
ALTER TABLE platform.diagnostic_signals DROP CONSTRAINT diagnostic_signals_attempt_ids_check;
ALTER TABLE platform.operational_alerts DROP CONSTRAINT operational_alerts_signal_ids_check;
ALTER TABLE platform.operational_alerts DROP CONSTRAINT operational_alerts_job_ids_check;
ALTER TABLE compute.external_attempt_dispatches DROP CONSTRAINT external_attempt_dispatches_provider_request_id_check;
ALTER TABLE compute.external_attempt_dispatches ADD CONSTRAINT external_attempt_dispatches_provider_request_id_check
  CHECK (provider_request_id IS NULL OR length(provider_request_id) >= 1);
