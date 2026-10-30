DO $$
DECLARE
    smoke_owner_id uuid := uuidv7();
    smoke_other_id uuid := uuidv7();
    smoke_conversation_id uuid := uuidv7();
    smoke_run_id uuid := uuidv7();
    smoke_user_message_id uuid := uuidv7();
    smoke_assistant_message_id uuid := uuidv7();
    smoke_binding_id uuid := uuidv7();
    smoke_prompt_id uuid := uuidv7();
    smoke_confirmation_id uuid := uuidv7();
    smoke_bad_confirmation_id uuid := uuidv7();
    smoke_authentication_event_id uuid := uuidv7();
    smoke_now timestamptz := clock_timestamp();
BEGIN
    INSERT INTO iam.identities (id, identity_kind, login_name, normalized_login_name, display_name)
    VALUES
        (smoke_owner_id, 'service_account', 'agent-confirm-owner', 'agent-confirm-owner', 'Agent confirm owner'),
        (smoke_other_id, 'service_account', 'agent-confirm-other', 'agent-confirm-other', 'Agent confirm other');

    INSERT INTO platform.assistant_conversations (id, owner_identity_id, title)
    VALUES (smoke_conversation_id, smoke_owner_id, 'Agent confirmation smoke');

    INSERT INTO platform.assistant_runs (
        id, conversation_id, owner_identity_id, user_message_id, assistant_message_id,
        requested_mode, effective_mode, status, routing, idempotency_key, request_digest, started_at
    ) VALUES (
        smoke_run_id, smoke_conversation_id, smoke_owner_id, smoke_user_message_id, smoke_assistant_message_id,
        'agent', 'agent', 'running', '{"modelKey":"agent.default"}', 'agent-confirm-smoke',
        decode(repeat('11', 32), 'hex'), clock_timestamp()
    );

    INSERT INTO platform.assistant_messages (
        id, conversation_id, run_id, message_ordinal, role, content,
        requested_mode, effective_mode, status, created_at, completed_at
    ) VALUES
        (smoke_user_message_id, smoke_conversation_id, smoke_run_id, 1, 'user', 'run it', 'agent', 'agent', 'completed', smoke_now, smoke_now),
        (smoke_assistant_message_id, smoke_conversation_id, smoke_run_id, 2, 'assistant', '', 'agent', 'agent', 'streaming', smoke_now, NULL);

    INSERT INTO platform.agent_session_bindings (
        id, owner_identity_id, platform_conversation_id, workspace_key, sandbox_key,
        adapter_key, upstream_version, upstream_artifact_digest, opencode_session_id
    ) VALUES (
        smoke_binding_id, smoke_owner_id, smoke_conversation_id, 'workspace.confirm-smoke', 'sandbox.confirm-smoke',
        'opencode.v1_18', '1.18.16', decode(repeat('22', 32), 'hex'), 'ses_confirm_smoke'
    );

    INSERT INTO platform.agent_prompts (
        id, binding_id, platform_run_id, idempotency_key, request_digest, opencode_message_id
    ) VALUES (
        smoke_prompt_id, smoke_binding_id, smoke_run_id, 'prompt-confirm-smoke',
        decode(repeat('33', 32), 'hex'), 'msg_confirm_smoke'
    );

    INSERT INTO platform.agent_operation_confirmations (
        id, owner_identity_id, agent_session_key, operation_kind, title_key,
        operation_scope, status, expires_at, bridge_schema_version, binding_id,
        prompt_id, upstream_request_id, tool_name, action_digest, side_effect_class,
        policy_id, policy_revision, policy_disposition
    ) VALUES (
        smoke_confirmation_id, smoke_owner_id, smoke_binding_id::text, 'shell.execute',
        'agent.operation.shell.execute', '{"summary":"run command","scope":{"argv":["make"]}}',
        'pending', clock_timestamp() + interval '2 minutes', 1, smoke_binding_id,
        smoke_prompt_id, 'per_confirm_smoke', 'bash', decode(repeat('44', 32), 'hex'),
        'non_idempotent', 'official-agent-operations.v1', 1, 'confirm'
    );

    UPDATE platform.agent_operation_confirmations
    SET status = 'approved', lifecycle_state = 'approved', upstream_reply_state = 'accepted',
        execution_boundary = 'unknown', decision_kind = 'approve', decided_at = clock_timestamp(),
        decided_by_identity_id = smoke_owner_id, authentication_event_id = smoke_authentication_event_id,
        authentication_proof_digest = decode(repeat('55', 32), 'hex'), authenticated_at = clock_timestamp(),
        revision = revision + 1
    WHERE id = smoke_confirmation_id;

    UPDATE platform.agent_operation_confirmations
    SET lifecycle_state = 'reconcile_required', execution_boundary = 'accepted',
        reconciliation_reason_code = 'crash_after_dispatch', revision = revision + 1
    WHERE id = smoke_confirmation_id;

    UPDATE platform.agent_operation_confirmations
    SET lifecycle_state = 'reconciled', reconciliation_outcome = 'executed',
        reconciliation_reason_code = 'verified_output_present', revision = revision + 1
    WHERE id = smoke_confirmation_id;

    IF (SELECT lifecycle_state FROM platform.agent_operation_confirmations WHERE id = smoke_confirmation_id) <> 'reconciled'
       OR (SELECT reconciliation_outcome FROM platform.agent_operation_confirmations WHERE id = smoke_confirmation_id) <> 'executed' THEN
        RAISE EXCEPTION 'Agent operation confirmation lifecycle was not durable';
    END IF;

    BEGIN
        INSERT INTO platform.agent_operation_confirmations (
            id, owner_identity_id, agent_session_key, operation_kind, title_key,
            operation_scope, status, expires_at, bridge_schema_version, binding_id,
            prompt_id, upstream_request_id, tool_name, action_digest, side_effect_class,
            policy_id, policy_revision, policy_disposition, lifecycle_state,
            decision_kind, decided_at, decided_by_identity_id, authentication_event_id,
            authentication_proof_digest, authenticated_at
        ) VALUES (
            smoke_bad_confirmation_id, smoke_owner_id, smoke_binding_id::text, 'shell.execute',
            'agent.operation.shell.execute', '{"summary":"bad actor","scope":{"argv":["make"]}}',
            'approved', clock_timestamp() + interval '2 minutes', 1, smoke_binding_id,
            smoke_prompt_id, 'per_bad_actor', 'bash', decode(repeat('66', 32), 'hex'),
            'non_idempotent', 'official-agent-operations.v1', 1, 'confirm', 'approved',
            'approve', clock_timestamp(), smoke_other_id, uuidv7(), decode(repeat('77', 32), 'hex'), clock_timestamp()
        );
        RAISE EXCEPTION 'expected cross-user confirmation decision rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    DELETE FROM platform.assistant_conversations WHERE id = smoke_conversation_id;
    IF EXISTS (SELECT 1 FROM platform.agent_operation_confirmations WHERE id = smoke_confirmation_id)
       OR EXISTS (SELECT 1 FROM platform.agent_session_bindings WHERE id = smoke_binding_id) THEN
        RAISE EXCEPTION 'Agent confirmation conversation cleanup did not cascade';
    END IF;
    DELETE FROM iam.identities WHERE id = smoke_owner_id;
    DELETE FROM iam.identities WHERE id = smoke_other_id;
END;
$$;
