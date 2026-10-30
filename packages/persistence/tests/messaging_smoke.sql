DO $$
DECLARE
    smoke_owner_id uuid := uuidv7();
    smoke_member_id uuid := uuidv7();
    smoke_conversation_id uuid := uuidv7();
    smoke_message_id uuid := uuidv7();
    smoke_notification_id uuid := uuidv7();
    smoke_direct_digest bytea := decode(repeat('ab', 32), 'hex');
BEGIN
    INSERT INTO iam.identities (
        id,identity_kind,login_name,normalized_login_name,display_name
    ) VALUES
        (smoke_owner_id,'service_account','messaging-smoke-owner','messaging-smoke-owner','Messaging owner'),
        (smoke_member_id,'service_account','messaging-smoke-member','messaging-smoke-member','Messaging member');

    INSERT INTO platform.messaging_conversations (
        id,conversation_kind,direct_key,created_by_identity_id
    ) VALUES (smoke_conversation_id,'direct',smoke_direct_digest,smoke_owner_id);

    INSERT INTO platform.messaging_participants (
        conversation_id,identity_id,participant_role
    ) VALUES
        (smoke_conversation_id,smoke_owner_id,'owner'),
        (smoke_conversation_id,smoke_member_id,'member');

    UPDATE platform.messaging_conversations
    SET last_message_sequence=1,revision=2
    WHERE id=smoke_conversation_id;

    INSERT INTO platform.messaging_messages (
        id,conversation_id,message_sequence,author_identity_id,author_kind,
        idempotency_key,request_digest,content
    ) VALUES (
        smoke_message_id,smoke_conversation_id,1,smoke_owner_id,'user',
        'messaging-smoke-1',decode(repeat('cd', 32), 'hex'),'durable hello'
    );

    INSERT INTO platform.messaging_delivery_receipts (
        message_id,identity_id,delivery_state,delivered_at,read_at
    ) VALUES
        (smoke_message_id,smoke_owner_id,'read',clock_timestamp(),clock_timestamp()),
        (smoke_message_id,smoke_member_id,'queued',NULL,NULL);

    INSERT INTO platform.messaging_notifications (
        id,identity_id,conversation_id,message_id,notification_kind
    ) VALUES (smoke_notification_id,smoke_member_id,smoke_conversation_id,smoke_message_id,'message');

    INSERT INTO platform.messaging_events (
        conversation_id,message_id,event_type,audience_identity_ids,author_identity_id,event_data
    ) VALUES (
        smoke_conversation_id,smoke_message_id,'message.created',ARRAY[smoke_owner_id,smoke_member_id],smoke_owner_id,
        jsonb_build_object('sequence',1,'authorIdentityId',smoke_owner_id)
    );

    INSERT INTO platform.messaging_presence (
        identity_id,presence_state,connection_count,last_seen_at,expires_at
    ) VALUES (
        smoke_member_id,'online',1,clock_timestamp(),clock_timestamp()+interval '60 seconds'
    );

    INSERT INTO platform.messaging_presence_connections (
        identity_id,connection_id,presence_state,last_seen_at,expires_at
    ) VALUES (
        smoke_member_id,uuidv7(),'online',clock_timestamp(),clock_timestamp()+interval '60 seconds'
    );

    UPDATE platform.messaging_delivery_receipts
    SET delivery_state='read',delivered_at=clock_timestamp(),read_at=clock_timestamp()
    WHERE message_id=smoke_message_id AND identity_id=smoke_member_id;

    IF (SELECT count(*) FROM platform.messaging_participants WHERE conversation_id=smoke_conversation_id AND left_at IS NULL) <> 2
       OR (SELECT content FROM platform.messaging_messages WHERE id=smoke_message_id) <> 'durable hello'
       OR (SELECT delivery_state FROM platform.messaging_delivery_receipts WHERE message_id=smoke_message_id AND identity_id=smoke_member_id) <> 'read'
       OR (SELECT count(*) FROM platform.messaging_events WHERE conversation_id=smoke_conversation_id) <> 1
       OR (SELECT count(*) FROM platform.messaging_notifications WHERE identity_id=smoke_member_id AND read_at IS NULL) <> 1 THEN
        RAISE EXCEPTION 'messaging durable state was not retained';
    END IF;

    BEGIN
        INSERT INTO platform.messaging_messages (
            conversation_id,message_sequence,author_identity_id,author_kind,application_key,
            idempotency_key,request_digest,content
        ) VALUES (
            smoke_conversation_id,2,smoke_owner_id,'user','forbidden.app',
            'messaging-invalid-app',decode(repeat('ef', 32), 'hex'),'invalid'
        );
        RAISE EXCEPTION 'expected user/application identity consistency rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO platform.messaging_conversations (
            conversation_kind,title,direct_key,created_by_identity_id
        ) VALUES ('direct','forbidden title',decode(repeat('12', 32), 'hex'),smoke_owner_id);
        RAISE EXCEPTION 'expected direct conversation shape rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    DELETE FROM platform.messaging_conversations WHERE id=smoke_conversation_id;
    IF EXISTS (SELECT 1 FROM platform.messaging_messages WHERE id=smoke_message_id)
       OR EXISTS (SELECT 1 FROM platform.messaging_notifications WHERE id=smoke_notification_id) THEN
        RAISE EXCEPTION 'messaging conversation cleanup did not cascade';
    END IF;
    DELETE FROM iam.identities WHERE id IN (smoke_owner_id,smoke_member_id);
END;
$$;
