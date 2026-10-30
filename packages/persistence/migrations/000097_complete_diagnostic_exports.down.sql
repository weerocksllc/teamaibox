-- Refuse a downgrade that would discard counts or access reasons.
ALTER TABLE platform.diagnostic_exports
 DROP CONSTRAINT diagnostic_exports_signal_count_check,
 DROP CONSTRAINT diagnostic_exports_health_count_check,
 DROP CONSTRAINT diagnostic_exports_alert_count_check,
 DROP CONSTRAINT diagnostic_exports_content_count_check,
 DROP CONSTRAINT diagnostic_exports_check;
ALTER TABLE platform.diagnostic_exports
 ADD CONSTRAINT diagnostic_exports_signal_count_check CHECK (signal_count BETWEEN 0 AND 5000),
 ADD CONSTRAINT diagnostic_exports_health_count_check CHECK (health_count BETWEEN 0 AND 5000),
 ADD CONSTRAINT diagnostic_exports_alert_count_check CHECK (alert_count BETWEEN 0 AND 5000),
 ADD CONSTRAINT diagnostic_exports_content_count_check CHECK (content_count BETWEEN 0 AND 100),
 ADD CONSTRAINT diagnostic_exports_check CHECK (
  (sensitive_included AND length(access_reason) BETWEEN 8 AND 256) OR (NOT sensitive_included AND access_reason IS NULL)),
 ALTER COLUMN signal_count TYPE integer,
 ALTER COLUMN health_count TYPE integer,
 ALTER COLUMN alert_count TYPE integer,
 ALTER COLUMN content_count TYPE integer;
DROP INDEX platform.diagnostic_signals_export_time_idx;
DROP INDEX platform.health_signals_export_time_idx;
DROP INDEX platform.operational_alerts_export_time_idx;
