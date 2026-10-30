-- Network-source metadata and owner permissions. No media is stored here.
CREATE TABLE platform.phone_udp_camera_policy (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (length(btrim(name))>0),
    enabled boolean NOT NULL,
    listen_address text NOT NULL CHECK (family(listen_address::inet)=4 AND masklen(listen_address::inet)=32),
    listen_port integer NOT NULL CHECK (listen_port BETWEEN 1024 AND 65535),
    allowed_sources text[] NOT NULL CHECK (cardinality(allowed_sources)>0),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    updated_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (node_id,listen_address,listen_port),
    UNIQUE (id,node_id)
);
CREATE TABLE platform.phone_udp_camera_users (
    policy_id uuid NOT NULL REFERENCES platform.phone_udp_camera_policy(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    PRIMARY KEY (policy_id,owner_id)
);
ALTER TABLE platform.phone_camera_inputs
    ADD COLUMN udp_node_id uuid,
    ADD COLUMN udp_policy_id uuid,
    ADD COLUMN udp_policy_revision bigint;
ALTER TABLE platform.phone_camera_inputs ADD CONSTRAINT phone_camera_udp_selection CHECK (
    (source_kind<>'udp' AND udp_node_id IS NULL AND udp_policy_id IS NULL AND udp_policy_revision IS NULL)
    OR coalesce((source_kind='udp' AND udp_node_id IS NOT NULL AND udp_policy_id IS NOT NULL
        AND udp_policy_revision BETWEEN 1 AND 9007199254740991
        AND source_config ?& ARRAY['kind','policyId','policyRevision','continueWithoutViewer']
        AND source_config->>'kind'='udp' AND source_config->>'policyId'=udp_policy_id::text
        AND source_config->'policyRevision'=to_jsonb(udp_policy_revision)
        AND source_config->'continueWithoutViewer'='true'::jsonb
        AND source_config-ARRAY['kind','policyId','policyRevision','continueWithoutViewer']='{}'::jsonb),false)
);
ALTER TABLE platform.phone_camera_inputs ADD CONSTRAINT phone_camera_udp_policy_fk
    FOREIGN KEY (udp_policy_id,udp_node_id) REFERENCES platform.phone_udp_camera_policy(id,node_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX phone_camera_udp_exclusive_idx ON platform.phone_camera_inputs(udp_policy_id)
    WHERE source_kind='udp' AND state<>'stopped';
CREATE FUNCTION platform.guard_phone_udp_camera_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source_kind='udp' AND NOT EXISTS (
        SELECT 1 FROM platform.phone_runs r JOIN platform.phone_udp_camera_policy d ON d.node_id=r.node_id
        JOIN platform.phone_udp_camera_users u ON u.policy_id=d.id
        WHERE r.id=NEW.run_id AND r.phone_id=NEW.phone_id AND r.owner_id=NEW.owner_id AND r.generation=NEW.generation
        AND r.state='running' AND d.id=NEW.udp_policy_id AND d.node_id=NEW.udp_node_id
        AND d.enabled AND d.revision=NEW.udp_policy_revision AND u.owner_id=NEW.owner_id
    ) THEN
        RAISE EXCEPTION 'phone network camera selection unauthorized' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_udp_camera_selection_guard BEFORE INSERT ON platform.phone_camera_inputs
    FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_udp_camera_selection();
