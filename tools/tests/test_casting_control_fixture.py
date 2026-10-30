"""Regression for inspecting an already stopped casting test session.

No appliance requests, browser sessions, accounts or receivers are created.
"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, call


SOURCE = Path(__file__).resolve().parents[1] / "probe_current_casting_controls.py"
SPEC = importlib.util.spec_from_file_location("casting_control_fixture", SOURCE)
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class ViewerSnapshotTests(unittest.TestCase):
    def test_terminal_sessions_do_not_request_a_rejected_viewer_endpoint(self):
        for state in ("stopped", "expired", "failed"):
            with self.subTest(state=state):
                client = Mock()
                self.assertEqual(fixture.viewer_snapshot(client, "/session/test", {"state": state}), [])
                client.ok.assert_not_called()

    def test_live_session_preserves_real_viewer_response(self):
        client = Mock()
        client.ok.return_value = {"data": [{"id": "viewer-test"}]}
        self.assertEqual(fixture.viewer_snapshot(client, "/session/test", {"state": "active"}),
                         [{"id": "viewer-test"}])
        client.ok.assert_called_once_with("/session/test/viewers")

    def test_live_session_errors_are_not_converted_to_empty_success(self):
        client = Mock()
        client.ok.side_effect = RuntimeError("cast_media_runtime_unavailable")
        with self.assertRaisesRegex(RuntimeError, "cast_media_runtime_unavailable"):
            fixture.viewer_snapshot(client, "/session/test", {"state": "active"})


class OwnedCleanupTests(unittest.TestCase):
    def test_busy_preflight_does_not_sign_out_existing_admin_cast(self):
        admin = Mock()
        result = fixture.cleanup_owned_resources(admin, None, [], [])
        admin.ok.assert_not_called()
        self.assertFalse(result['adminSignedOut'])
        self.assertTrue(result['adminClientDiscarded'])
        self.assertNotIn('sessionStopped', result)

    def test_only_owned_session_and_test_members_are_cleaned(self):
        admin, member = Mock(), Mock()
        admin.ok.side_effect = [{'state': 'stopped'}, {'status': 'disabled'}]
        result = fixture.cleanup_owned_resources(admin, 'owned-session', ['owned-member'], [member])
        self.assertEqual(admin.ok.call_args_list, [
            call('/api/v1/casting/sessions/owned-session/stop', {}),
            call('/api/v1/admin/users/owned-member/disable', {}),
        ])
        member.ok.assert_called_once_with('/api/auth/sign-out', {})
        self.assertTrue(result['sessionStopped'])
        self.assertEqual(result['disabled'], ['owned-member'])
        self.assertFalse(result['adminSignedOut'])

    def test_cleanup_failure_does_not_fall_back_to_global_sign_out(self):
        admin, member = Mock(), Mock()
        admin.ok.side_effect = RuntimeError('offline')
        result = fixture.cleanup_owned_resources(admin, 'owned-session', ['owned-member'], [member, admin])
        self.assertEqual(admin.ok.call_count, 2)
        self.assertNotIn(call('/api/auth/sign-out', {}), admin.ok.call_args_list)
        self.assertFalse(result['sessionStopped'])
        self.assertEqual(result['disabled'], [])
        member.ok.assert_called_once_with('/api/auth/sign-out', {})


if __name__ == "__main__":
    unittest.main()
