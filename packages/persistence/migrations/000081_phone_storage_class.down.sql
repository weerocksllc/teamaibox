-- No cleanup or recategorization on rollback. Refuse while this class is used.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM objects.storage_pool_data_classes WHERE data_class='phone-data') THEN
        RAISE EXCEPTION 'phone-data pools must be retired before schema rollback' USING ERRCODE='23514';
    END IF;
END $$;
DROP TRIGGER phone_pool_retirement_guard ON objects.storage_pools;
DROP FUNCTION platform.guard_phone_pool_retirement();
DROP TRIGGER phone_pool_class_guard ON objects.storage_pool_data_classes;
DROP FUNCTION platform.guard_phone_pool_class();
ALTER TABLE objects.storage_pool_data_classes DROP CONSTRAINT storage_pool_data_classes_data_class_check;
ALTER TABLE objects.storage_pool_data_classes
    ADD CONSTRAINT storage_pool_data_classes_data_class_check CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset', 'checkpoint',
        'model-artifact', 'agent-workspace', 'plugin-data', 'cache'
    ));
