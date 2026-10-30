DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM compute.protected_office_deployment_actions
        WHERE run_id ~ '^protected-office-set-deployment-v5-[0-9]{8}-a[1-9][0-9]*$'
    ) THEN
        RAISE EXCEPTION 'cannot remove protected-office v5 identity while v5 journal rows exist';
    END IF;
END;
$$;

ALTER TABLE compute.protected_office_deployment_actions
DROP CONSTRAINT protected_office_deployment_actions_run_id_check;

ALTER TABLE compute.protected_office_deployment_actions
ADD CONSTRAINT protected_office_deployment_actions_run_id_check CHECK (
    run_id ~ '^protected-office-set-deployment-[0-9]{8}-a[1-9][0-9]*$'
);
