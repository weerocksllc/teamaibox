ALTER TABLE compute.protected_office_deployment_actions
DROP CONSTRAINT protected_office_deployment_actions_run_id_check;

ALTER TABLE compute.protected_office_deployment_actions
ADD CONSTRAINT protected_office_deployment_actions_run_id_check CHECK (
    run_id ~ '^protected-office-set-deployment(-v5)?-[0-9]{8}-a[1-9][0-9]*$'
);
