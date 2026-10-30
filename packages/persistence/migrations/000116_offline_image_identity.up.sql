-- Offline image imports may have no RepoDigest. A full local content ID is
-- immutable too; the runtime checks its actual ID, Linux OS and ARM64 arch.
-- Existing rows/VMs are not rewritten by this migration.
ALTER TABLE compute.worker_instances
    DROP CONSTRAINT worker_instances_image_reference_check;
ALTER TABLE compute.worker_instances
    ADD CONSTRAINT worker_instances_image_reference_check CHECK (
        image_reference ~ '^([a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$'
    );
ALTER TABLE platform.agent_sandboxes
    DROP CONSTRAINT agent_sandboxes_image_reference_check;
ALTER TABLE platform.agent_sandboxes
    ADD CONSTRAINT agent_sandboxes_image_reference_check CHECK (
        image_reference ~ '^([a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$'
    );
