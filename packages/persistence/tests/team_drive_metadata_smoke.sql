\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    actor_id uuid := uuidv7();
    member_id uuid := uuidv7();
    object_id uuid := uuidv7();
    root_id uuid;
    other_root_id uuid;
    folder_id uuid;
    smoke_file_id uuid;
    child_id uuid;
BEGIN
    INSERT INTO iam.identities (id,identity_kind,login_name,normalized_login_name,display_name)
    VALUES
        (actor_id,'service_account','drive-smoke-owner','drive-smoke-owner','Drive smoke owner'),
        (member_id,'service_account','drive-smoke-member','drive-smoke-member','Drive smoke member');

    INSERT INTO objects.namespaces (namespace_key,quota_bytes)
    VALUES ('team:drive-smoke',1048576);
    INSERT INTO objects.encrypted_blobs (
        blob_key,plaintext_size,plaintext_sha256,ciphertext_size,ciphertext_sha256,
        data_algorithm,data_nonce,data_tag,wrap_algorithm,wrapping_key_version,
        wrap_nonce,wrapped_data_key,wrap_tag
    ) VALUES (
        'objects/drive-smoke',128,decode(repeat('11',32),'hex'),144,decode(repeat('21',32),'hex'),
        'aes-256-gcm',decode(repeat('31',12),'hex'),decode(repeat('41',16),'hex'),
        'aes-256-gcm-keywrap',1,decode(repeat('51',12),'hex'),decode(repeat('61',32),'hex'),decode(repeat('71',16),'hex')
    );
    INSERT INTO objects.blob_claims (
        blob_key,namespace_key,claim_kind,claim_state,expected_size,expected_sha256,verified_at,expires_at
    ) VALUES (
        'objects/drive-smoke','team:drive-smoke','object_candidate','verified',128,
        decode(repeat('11',32),'hex'),clock_timestamp(),clock_timestamp()+interval '1 hour'
    );
    INSERT INTO objects.object_entries (id,namespace_key,object_key)
    VALUES (object_id,'team:drive-smoke','drive/input.txt');
    INSERT INTO objects.object_versions (
        object_id,version,blob_key,size,sha256,content_type,created_by_identity_id
    ) VALUES (
        object_id,1,'objects/drive-smoke',128,decode(repeat('11',32),'hex'),'text/plain',actor_id
    );

    INSERT INTO files.roots (scope_kind,scope_key,quota_bytes,created_by_identity_id)
    VALUES ('team','team.drive-smoke',1024,actor_id) RETURNING id INTO root_id;
    INSERT INTO files.roots (scope_kind,scope_key,quota_bytes,created_by_identity_id)
    VALUES ('user',member_id::text,1024,member_id) RETURNING id INTO other_root_id;
    INSERT INTO files.entries (root_id,entry_kind,entry_name,owner_identity_id)
    VALUES (root_id,'folder','Documents',actor_id) RETURNING id INTO folder_id;
    INSERT INTO files.entries (root_id,parent_id,entry_kind,entry_name,owner_identity_id)
    VALUES (root_id,folder_id,'file','release.txt',actor_id) RETURNING id INTO smoke_file_id;
    INSERT INTO files.versions (
        file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,
        provenance,created_by_identity_id
    ) VALUES (
        smoke_file_id,root_id,1,object_id,1,128,'text/plain',decode(repeat('11',32),'hex'),
        '{"source":"team-drive-smoke"}'::jsonb,actor_id
    );

    IF (SELECT current_version FROM files.entries WHERE id=smoke_file_id) <> 1
       OR (SELECT used_bytes FROM files.roots WHERE id=root_id) <> 128 THEN
        RAISE EXCEPTION 'team drive version and quota did not advance atomically';
    END IF;

    BEGIN
        INSERT INTO files.versions (
            file_id,root_id,version,object_id,object_version,byte_size,media_type,sha256,created_by_identity_id
        ) VALUES (
            smoke_file_id,root_id,2,object_id,1,127,'text/plain',decode(repeat('11',32),'hex'),actor_id
        );
        RAISE EXCEPTION 'expected object fact mismatch rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO files.entries (root_id,parent_id,entry_kind,entry_name,owner_identity_id)
        VALUES (root_id,folder_id,'file','RELEASE.TXT',actor_id);
        RAISE EXCEPTION 'expected active sibling conflict';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    INSERT INTO files.entries (root_id,parent_id,entry_kind,entry_name,owner_identity_id)
    VALUES (root_id,folder_id,'folder','Child',actor_id) RETURNING id INTO child_id;
    BEGIN
        UPDATE files.entries SET parent_id=child_id WHERE id=folder_id;
        RAISE EXCEPTION 'expected hierarchy cycle rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO files.acl (
        root_id,entry_id,principal_kind,principal_key,access_role,inherited,created_by_identity_id
    ) VALUES (root_id,folder_id,'identity',member_id::text,'viewer',true,actor_id);
    INSERT INTO files.shares (
        root_id,entry_id,principal_kind,principal_key,access_role,expires_at,created_by_identity_id
    ) VALUES (root_id,smoke_file_id,'identity',member_id::text,'viewer',clock_timestamp()+interval '1 hour',actor_id);

    BEGIN
        INSERT INTO files.acl (
            root_id,entry_id,principal_kind,principal_key,access_role,created_by_identity_id
        ) VALUES (other_root_id,smoke_file_id,'identity',member_id::text,'viewer',actor_id);
        RAISE EXCEPTION 'expected cross-root ACL rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    UPDATE files.entries
    SET trashed_at=clock_timestamp(),retention_until=clock_timestamp()+interval '30 days',revision=revision+1
    WHERE id=folder_id;
    IF NOT EXISTS (
        SELECT 1 FROM files.versions version WHERE version.file_id = smoke_file_id
    ) THEN
        RAISE EXCEPTION 'recycled hierarchy lost immutable file history';
    END IF;

    DELETE FROM files.entries WHERE id=folder_id;
    IF EXISTS (
        SELECT 1 FROM files.versions version WHERE version.file_id = smoke_file_id
    )
       OR (SELECT used_bytes FROM files.roots WHERE id=root_id) <> 0 THEN
        RAISE EXCEPTION 'purged hierarchy did not release file metadata quota';
    END IF;
END;
$$;

ROLLBACK;
