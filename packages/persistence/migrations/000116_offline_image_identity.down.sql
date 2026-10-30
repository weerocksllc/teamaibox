-- Refuse downgrade while new-format references exist. Never delete rows or
-- substitute mutable tags just to make an older binary accept an installation.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM compute.worker_instances WHERE image_reference ~ '^sha256:')
       OR EXISTS (SELECT 1 FROM platform.agent_sandboxes WHERE image_reference ~ '^sha256:') THEN
        RAISE EXCEPTION 'offline image references require the installed runtime; downgrade refused';
    END IF;
END $$;
ALTER TABLE compute.worker_instances
    DROP CONSTRAINT worker_instances_image_reference_check;
ALTER TABLE compute.worker_instances
    ADD CONSTRAINT worker_instances_image_reference_check CHECK (
        image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
    );
ALTER TABLE platform.agent_sandboxes
    DROP CONSTRAINT agent_sandboxes_image_reference_check;
ALTER TABLE platform.agent_sandboxes
    ADD CONSTRAINT agent_sandboxes_image_reference_check CHECK (
        image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
    );
