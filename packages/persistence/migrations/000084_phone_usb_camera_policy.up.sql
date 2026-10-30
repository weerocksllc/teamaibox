-- Device metadata only. No host paths, camera frames, extra memory budget or
-- cross-node routing. The existing input row owns the exclusive device claim.
CREATE TABLE platform.phone_usb_camera_policy (
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    device_id uuid NOT NULL,
    enabled boolean NOT NULL,
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    updated_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (node_id,device_id)
);
CREATE TABLE platform.phone_usb_camera_users (
    node_id uuid NOT NULL,
    device_id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    PRIMARY KEY (node_id,device_id,owner_id),
    FOREIGN KEY (node_id,device_id) REFERENCES platform.phone_usb_camera_policy(node_id,device_id) ON DELETE RESTRICT
);
ALTER TABLE platform.phone_camera_inputs
    ADD COLUMN usb_node_id uuid,
    ADD COLUMN usb_device_id uuid,
    ADD COLUMN usb_policy_revision bigint;
ALTER TABLE platform.phone_camera_inputs ADD CONSTRAINT phone_camera_usb_selection CHECK (
    (source_kind<>'usb' AND usb_node_id IS NULL AND usb_device_id IS NULL AND usb_policy_revision IS NULL)
    OR coalesce((source_kind='usb' AND usb_node_id IS NOT NULL AND usb_device_id IS NOT NULL
        AND usb_policy_revision IS NOT NULL
        AND usb_policy_revision BETWEEN 1 AND 9007199254740991
        AND source_config ?& ARRAY['kind','deviceId','attachmentId','continueWithoutViewer']
        AND source_config->>'kind'='usb' AND source_config->>'deviceId'=usb_device_id::text
        AND source_config->>'attachmentId' ~ '^[a-f0-9]{64}$'
        AND source_config->'continueWithoutViewer'='true'::jsonb
        AND source_config-ARRAY['kind','deviceId','attachmentId','continueWithoutViewer']='{}'::jsonb),false)
);
ALTER TABLE platform.phone_camera_inputs ADD CONSTRAINT phone_camera_usb_policy_fk
    FOREIGN KEY (usb_node_id,usb_device_id) REFERENCES platform.phone_usb_camera_policy(node_id,device_id) ON DELETE RESTRICT;
-- A revoked/expired but not confirmed closed producer still owns its slot.
-- Time alone cannot free a device while physical shutdown is unconfirmed.
CREATE UNIQUE INDEX phone_camera_usb_exclusive_idx ON platform.phone_camera_inputs(usb_node_id,usb_device_id)
    WHERE source_kind='usb' AND state<>'stopped';
CREATE FUNCTION platform.guard_phone_usb_camera_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source_kind='usb' AND NOT EXISTS (
        SELECT 1 FROM platform.phone_runs r JOIN platform.phone_usb_camera_policy d ON d.node_id=r.node_id
        JOIN platform.phone_usb_camera_users u ON u.node_id=d.node_id AND u.device_id=d.device_id
        WHERE r.id=NEW.run_id AND r.phone_id=NEW.phone_id AND r.owner_id=NEW.owner_id AND r.generation=NEW.generation
        AND r.state='running' AND d.node_id=NEW.usb_node_id AND d.device_id=NEW.usb_device_id
        AND d.enabled AND d.revision=NEW.usb_policy_revision AND u.owner_id=NEW.owner_id
    ) THEN
        RAISE EXCEPTION 'phone USB camera selection unauthorized' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_usb_camera_selection_guard BEFORE INSERT ON platform.phone_camera_inputs
    FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_usb_camera_selection();
