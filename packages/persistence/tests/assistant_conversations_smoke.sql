DO $$
DECLARE
    smoke_owner_id uuid := uuidv7();
    smoke_conversation_id uuid := uuidv7();
    smoke_run_id uuid := uuidv7();
    smoke_user_message_id uuid := uuidv7();
    smoke_assistant_message_id uuid := uuidv7();
    smoke_now timestamptz := clock_timestamp();
BEGIN
    INSERT INTO iam.identities (
        id, identity_kind, login_name, normalized_login_name, display_name
    ) VALUES (
        smoke_owner_id, 'service_account', 'assistant-smoke', 'assistant-smoke', 'Assistant smoke'
    );

    INSERT INTO platform.assistant_conversations (
        id, owner_identity_id, title
    ) VALUES (
        smoke_conversation_id, smoke_owner_id, 'Shared answer and Agent history'
    );

    INSERT INTO platform.assistant_runs (
        id, conversation_id, owner_identity_id, user_message_id, assistant_message_id,
        requested_mode, effective_mode, status, routing, idempotency_key,
        request_digest, started_at
    ) VALUES (
        smoke_run_id, smoke_conversation_id, smoke_owner_id, smoke_user_message_id, smoke_assistant_message_id,
        'auto', 'agent', 'running',
        '{"effectiveMode":"agent","targetKind":"internal","providerKey":"platform.compute","modelKey":"auto.agent","profileKey":null,"reasonKey":"assistant.routing.agent_intent"}',
        'assistant-smoke-1', decode(repeat('ab', 32), 'hex'), clock_timestamp()
    );

    INSERT INTO platform.assistant_messages (
        id, conversation_id, run_id, message_ordinal, role, content, requested_mode, effective_mode,
        status, routing, created_at, completed_at
    ) VALUES
    (
        smoke_user_message_id, smoke_conversation_id, smoke_run_id, 1, 'user', 'write the report', 'auto',
        'agent', 'completed', '{"modelKey":"auto.agent"}', smoke_now, smoke_now
    ),
    (
        smoke_assistant_message_id, smoke_conversation_id, smoke_run_id, 2, 'assistant', '', 'auto',
        'agent', 'streaming', '{"modelKey":"auto.agent"}', smoke_now, NULL
    );

    INSERT INTO platform.assistant_events (
        conversation_id, run_id, event_type, event_data
    ) VALUES
        (smoke_conversation_id, smoke_run_id, 'message.created', jsonb_build_object('messageId', smoke_user_message_id)),
        (smoke_conversation_id, smoke_run_id, 'routing.selected', '{"effectiveMode":"agent"}'),
        (smoke_conversation_id, smoke_run_id, 'tool.started', '{"toolCallId":"tool.write.1"}'),
        (smoke_conversation_id, smoke_run_id, 'confirmation.requested', '{"scope":{"path":"/workspace/report.md"}}');

    UPDATE platform.assistant_messages
    SET content = 'report written', status = 'completed', completed_at = clock_timestamp(),
        tool_calls = '[{"id":"tool.write.1","status":"succeeded"}]',
        artifacts = '[{"referenceId":"artifact.report.1"}]',
        sources = '[{"referenceId":"object.source.1","label":"Team source","url":"/api/v1/objects/source"}]',
        usage = '{"inputTokens":10,"outputTokens":2,"costMicrounits":0,"currency":"CNY"}'
    WHERE id = smoke_assistant_message_id;

    UPDATE platform.assistant_runs
    SET status = 'completed', completed_at = clock_timestamp()
    WHERE id = smoke_run_id;

    IF (SELECT count(*) FROM platform.assistant_messages WHERE conversation_id = smoke_conversation_id) <> 2
       OR (SELECT status FROM platform.assistant_runs WHERE id = smoke_run_id) <> 'completed'
       OR (SELECT count(*) FROM platform.assistant_events WHERE conversation_id = smoke_conversation_id) <> 4 THEN
        RAISE EXCEPTION 'assistant conversation history or event evidence was not retained';
    END IF;

    BEGIN
        INSERT INTO platform.assistant_runs (
            conversation_id, owner_identity_id, user_message_id, assistant_message_id,
            requested_mode, effective_mode, status, routing, idempotency_key,
            request_digest
        ) VALUES (
            smoke_conversation_id, smoke_owner_id, uuidv7(), uuidv7(), 'answer', 'answer', 'queued',
            '{"modelKey":"auto.answer"}', 'assistant-smoke-1', decode(repeat('cd', 32), 'hex')
        );
        RAISE EXCEPTION 'expected Assistant idempotency uniqueness rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    DELETE FROM iam.identities WHERE id = smoke_owner_id;
    IF EXISTS (SELECT 1 FROM platform.assistant_conversations WHERE id = smoke_conversation_id)
       OR EXISTS (SELECT 1 FROM platform.assistant_runs WHERE id = smoke_run_id)
       OR EXISTS (SELECT 1 FROM platform.assistant_messages WHERE run_id = smoke_run_id)
       OR EXISTS (SELECT 1 FROM platform.assistant_events WHERE run_id = smoke_run_id) THEN
        RAISE EXCEPTION 'assistant owner cleanup did not cascade';
    END IF;
END;
$$;
