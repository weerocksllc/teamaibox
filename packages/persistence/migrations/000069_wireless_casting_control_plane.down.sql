DROP FUNCTION platform.downgrade_cast_audience_to_owner(uuid, uuid, bigint);

DROP TRIGGER cast_session_events_append_only ON platform.cast_session_events;
DROP FUNCTION platform.reject_cast_session_event_mutation();
DROP TABLE platform.cast_session_events;

DROP TRIGGER cast_viewer_grants_capacity_guard ON platform.cast_viewer_grants;
DROP TRIGGER cast_viewer_grants_write_guard ON platform.cast_viewer_grants;
DROP FUNCTION platform.enforce_cast_viewer_capacity();
DROP FUNCTION platform.enforce_cast_viewer_grant_write();
DROP TABLE platform.cast_viewer_grants;

DROP TRIGGER cast_viewer_invitations_write_guard ON platform.cast_viewer_invitations;
DROP FUNCTION platform.enforce_cast_invitation_write();
DROP TABLE platform.cast_viewer_invitations;

DROP FUNCTION platform.cast_identity_in_current_audience(uuid, uuid);

DROP TRIGGER cast_audience_targets_session_boundary
ON platform.cast_audience_targets;
DROP TRIGGER cast_sessions_audience_boundary ON platform.cast_sessions;
DROP FUNCTION platform.enforce_cast_audience_boundary();

DROP TRIGGER cast_audience_targets_write_guard
ON platform.cast_audience_targets;
DROP FUNCTION platform.enforce_cast_audience_target_write();
DROP TABLE platform.cast_audience_targets;

DROP TRIGGER cast_sessions_write_guard ON platform.cast_sessions;
DROP FUNCTION platform.enforce_cast_session_write();
DROP TABLE platform.cast_sessions;
DROP FUNCTION platform.cast_output_sinks_valid(text[]);
DROP FUNCTION platform.cast_identity_has_permission(uuid, text, timestamptz);

DELETE FROM iam.role_permissions
WHERE permission_key IN ('cast:use', 'cast:share', 'cast:view', 'cast:manage');
DELETE FROM iam.permissions
WHERE permission_key IN ('cast:use', 'cast:share', 'cast:view', 'cast:manage');
