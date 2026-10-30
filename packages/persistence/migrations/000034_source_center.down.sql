DROP TRIGGER source_health_events_append_only ON source_center.health_events;
DROP FUNCTION source_center.reject_health_event_mutation();
DROP TABLE source_center.health_events;
DROP TABLE source_center.policies;
DROP TABLE source_center.sources;
DROP SCHEMA source_center;
