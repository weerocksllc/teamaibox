ALTER TABLE compute.providers
    DROP CONSTRAINT providers_lifecycle_state_check;

ALTER TABLE compute.providers
    ADD CONSTRAINT providers_lifecycle_state_check CHECK (
        lifecycle_state IN ('disabled', 'healthy', 'degraded', 'unavailable', 'removed')
    );
