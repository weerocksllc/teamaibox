-- Phone disks share pool identity/capacity, not the object blob placement path.
-- Only the pool classification accepts phone-data; blob reservations and
-- allocations intentionally retain their existing closed data-class lists.
ALTER TABLE objects.storage_pool_data_classes
    DROP CONSTRAINT storage_pool_data_classes_data_class_check;
ALTER TABLE objects.storage_pool_data_classes
    ADD CONSTRAINT storage_pool_data_classes_data_class_check CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset', 'checkpoint',
        'model-artifact', 'agent-workspace', 'plugin-data', 'cache', 'phone-data'
    ));

CREATE FUNCTION platform.guard_phone_pool_class() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
    target := CASE WHEN TG_OP='DELETE' THEN OLD.pool_id ELSE NEW.pool_id END;
    PERFORM 1 FROM objects.storage_pools WHERE pool_id=target FOR UPDATE;
    IF TG_OP<>'DELETE' THEN
        IF EXISTS (SELECT 1 FROM objects.storage_pool_data_classes c WHERE c.pool_id=target
            AND (c.data_class='phone-data') IS DISTINCT FROM (NEW.data_class='phone-data')
            AND (TG_OP='INSERT' OR (c.pool_id,c.data_class) IS DISTINCT FROM (OLD.pool_id,OLD.data_class))) THEN
            RAISE EXCEPTION 'phone pools cannot contain object data classes' USING ERRCODE='23514';
        END IF;
    END IF;
    IF TG_OP<>'INSERT' AND OLD.data_class='phone-data' AND EXISTS (
        SELECT 1 FROM platform.phones p WHERE p.pool_id=OLD.pool_id AND p.state<>'deleted') THEN
        RAISE EXCEPTION 'phone pool class has live allocations' USING ERRCODE='23514';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER phone_pool_class_guard BEFORE INSERT OR UPDATE OR DELETE ON objects.storage_pool_data_classes
    FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_pool_class();

CREATE FUNCTION platform.guard_phone_pool_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.lifecycle_state IN ('drained','removed') AND EXISTS (
        SELECT 1 FROM platform.phones p WHERE p.pool_id=NEW.pool_id AND p.state<>'deleted') THEN
        RAISE EXCEPTION 'phone pool has live allocations' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER phone_pool_retirement_guard BEFORE UPDATE ON objects.storage_pools
    FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_pool_retirement();
