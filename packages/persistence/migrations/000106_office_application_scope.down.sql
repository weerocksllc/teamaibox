-- Reverting a schema must not silently reactivate removed execution or grants.
ALTER TABLE compute.capabilities DROP CONSTRAINT office_supported_modalities;
