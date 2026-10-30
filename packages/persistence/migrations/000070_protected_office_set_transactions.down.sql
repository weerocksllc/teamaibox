DROP TRIGGER protected_office_set_write_guard
ON compute.protected_office_sets;
DROP FUNCTION compute.enforce_protected_office_set_write();

DROP TRIGGER protected_office_transaction_write_guard
ON compute.protected_office_set_transactions;
DROP FUNCTION compute.enforce_protected_office_transaction_write();

DROP TABLE compute.protected_office_sets;
DROP TABLE compute.protected_office_set_transactions;

DROP FUNCTION compute.protected_office_steps_valid(jsonb);
DROP FUNCTION compute.protected_office_recovery_steps_valid(jsonb);
DROP FUNCTION compute.protected_office_manifest_valid(jsonb);
DROP FUNCTION compute.protected_office_previous_identities_valid(jsonb);
DROP FUNCTION compute.protected_office_identity_array_valid(jsonb);
