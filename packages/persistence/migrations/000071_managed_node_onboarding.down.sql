DROP TRIGGER node_onboarding_events_append_only
ON compute.node_onboarding_events;
DROP FUNCTION compute.reject_node_onboarding_event_mutation();
DROP TABLE compute.node_onboarding_events;
DROP TABLE compute.node_onboarding_transactions;
