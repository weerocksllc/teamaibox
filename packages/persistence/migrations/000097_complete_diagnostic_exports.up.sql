ALTER TABLE platform.diagnostic_exports
 DROP CONSTRAINT diagnostic_exports_signal_count_check,
 DROP CONSTRAINT diagnostic_exports_health_count_check,
 DROP CONSTRAINT diagnostic_exports_alert_count_check,
 DROP CONSTRAINT diagnostic_exports_content_count_check,
 DROP CONSTRAINT diagnostic_exports_check,
 ALTER COLUMN signal_count TYPE bigint,
 ALTER COLUMN health_count TYPE bigint,
 ALTER COLUMN alert_count TYPE bigint,
 ALTER COLUMN content_count TYPE bigint;
ALTER TABLE platform.diagnostic_exports
 ADD CONSTRAINT diagnostic_exports_signal_count_check CHECK (signal_count BETWEEN 0 AND 9007199254740991),
 ADD CONSTRAINT diagnostic_exports_health_count_check CHECK (health_count BETWEEN 0 AND 9007199254740991),
 ADD CONSTRAINT diagnostic_exports_alert_count_check CHECK (alert_count BETWEEN 0 AND 9007199254740991),
 ADD CONSTRAINT diagnostic_exports_content_count_check CHECK (content_count BETWEEN 0 AND 9007199254740991),
 ADD CONSTRAINT diagnostic_exports_check CHECK (
   (sensitive_included AND length(access_reason)>=8) OR (NOT sensitive_included AND access_reason IS NULL));

-- Populated appliances prebuild these concurrently before this transaction.
-- Fresh installations create them here with the same definition.
CREATE INDEX IF NOT EXISTS diagnostic_signals_export_time_idx ON platform.diagnostic_signals (observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS health_signals_export_time_idx ON platform.health_signals (observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS operational_alerts_export_time_idx ON platform.operational_alerts (last_seen_at DESC, id DESC);
