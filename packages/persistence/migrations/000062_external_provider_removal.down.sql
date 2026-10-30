UPDATE compute.providers
SET lifecycle_state = 'disabled'
WHERE lifecycle_state = 'removed';

ALTER TABLE compute.providers
    DROP CONSTRAINT providers_lifecycle_state_check;

ALTER TABLE compute.providers
    ADD CONSTRAINT providers_lifecycle_state_check CHECK (
        lifecycle_state IN ('disabled', 'healthy', 'degraded', 'unavailable')
    );
