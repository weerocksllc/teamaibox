DROP TRIGGER IF EXISTS unlock_protection_transition_event_immutable ON security.unlock_protection_transition_events;
DROP TRIGGER IF EXISTS unlock_protection_transition_no_delete ON security.unlock_protection_transitions;
DROP TRIGGER IF EXISTS unlock_protection_transition_mutation ON security.unlock_protection_transitions;
DROP FUNCTION IF EXISTS security.reject_unlock_transition_delete();
DROP FUNCTION IF EXISTS security.enforce_unlock_transition_mutation();
DROP TABLE IF EXISTS security.unlock_protection_transition_events;
DROP TABLE IF EXISTS security.unlock_protection_transitions;
DROP SCHEMA IF EXISTS security;
