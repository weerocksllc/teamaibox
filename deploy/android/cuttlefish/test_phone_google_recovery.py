import copy
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools'))
import inspect_phone_google_compliance
sys.modules['phone_google_compliance'] = inspect_phone_google_compliance
from phone_google_recovery import GoogleCacheRecovery, install


IDENTITY = hashlib.sha256(b'1234567890123456789').hexdigest()


def observation(legacy='1', decision='ENFORCE'):
    return {'gsfIdSha256': IDENTITY, 'legacyStatus': legacy, 'caches': {
        kind: {'gsfIdSha256': IDENTITY, 'decision': decision, 'sha256': char * 64}
        for kind, char in [('play', 'a'), ('gms', 'b')]}}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.runtime = types.SimpleNamespace(stopping=threading.Event(), adb=Mock())
        self.recovery = GoogleCacheRecovery(self.runtime, self.directory.name)
        self.recovery.snapshot = Mock(return_value=observation())
        self.recovery.refresh = Mock()

    def test_registered_stale_verdict_refreshed_once_across_runtime_restarts(self):
        self.recovery.tick()
        self.recovery.tick()
        self.recovery.refresh.assert_called_once()
        reloaded = GoogleCacheRecovery(self.runtime, self.directory.name)
        reloaded.snapshot = self.recovery.snapshot
        reloaded.refresh = Mock()
        reloaded.tick()
        reloaded.refresh.assert_not_called()
        self.assertEqual(reloaded.state['state'], 'google_still_rejects_no_retry')

    def test_registration_transition_rearms_but_repeated_denials_do_not(self):
        self.recovery.tick()
        self.recovery.snapshot.return_value = observation('3')
        self.recovery.tick()
        self.assertEqual(self.recovery.state['state'], 'registration_required')
        self.recovery.snapshot.return_value = observation()
        self.recovery.tick()
        self.recovery.tick()
        self.assertEqual(self.recovery.refresh.call_count, 2)

    def test_unregistered_new_phone_not_automatically_registered_or_cleared(self):
        self.recovery.snapshot.return_value = observation('3')
        self.recovery.tick()
        self.recovery.tick()
        self.recovery.refresh.assert_not_called()
        self.runtime.adb.assert_not_called()

    def test_already_allowed_phone_untouched(self):
        self.recovery.snapshot.return_value = observation(decision='DO_NOT_ENFORCE')
        self.recovery.tick()
        self.recovery.refresh.assert_not_called()
        self.assertEqual(self.recovery.state['state'], 'google_verdict_allows')

    def test_partial_unknown_or_mismatched_cache_left_alone(self):
        for kind in ('missing', 'unknown', 'mismatch'):
            item = observation()
            if kind == 'missing': del item['caches']['play']
            if kind == 'unknown': item['caches']['play']['decision'] = 'UNKNOWN'
            if kind == 'mismatch': item['caches']['gms']['gsfIdSha256'] = 'f' * 64
            self.recovery.snapshot.return_value = item
            self.recovery.tick()
        self.recovery.refresh.assert_not_called()

    def test_action_failure_does_not_repeat_or_drop_accounts(self):
        self.recovery.refresh.side_effect = RuntimeError('simulated')
        with self.assertRaises(RuntimeError): self.recovery.tick()
        self.recovery.refresh.reset_mock()
        self.recovery.tick()
        self.recovery.refresh.assert_not_called()

    def test_exact_cache_backups_not_app_data_clear(self):
        recovery = GoogleCacheRecovery(self.runtime, self.directory.name)
        recovery.shell = Mock(side_effect=['mResumedActivity: com.android.vending/.Main', '', '', ''])
        recovery.refresh(observation()['caches'])
        commands = [call.args[0] for call in recovery.shell.call_args_list]
        self.assertIn('sha256sum', commands[2])
        self.assertEqual(commands[2].count('mv '), 2)
        self.assertIn('.before-registration-refresh-', commands[2])
        self.assertIn('am start', commands[3])
        for forbidden in ('pm clear', 'settings put', 'setprop', 'INSERT', 'UPDATE', 'DELETE', 'rm '):
            self.assertNotIn(forbidden, '\n'.join(commands))

    def test_background_does_not_open_store_over_another_app(self):
        recovery = GoogleCacheRecovery(self.runtime, self.directory.name)
        recovery.shell = Mock(side_effect=['mResumedActivity: org.example.camera/.Main', '', ''])
        recovery.refresh(observation()['caches'])
        self.assertEqual(recovery.shell.call_count, 3)

    def test_stopping_prevents_guest_commands(self):
        self.runtime.stopping.set()
        with self.assertRaisesRegex(RuntimeError, 'phone_stopping'):
            self.recovery.shell('unused')
        self.runtime.adb.assert_not_called()

    def test_standard_phone_runtime_is_not_wrapped(self):
        network = types.SimpleNamespace(NetworkRuntime=object)
        install(network, marker=str(Path(self.directory.name) / 'absent'))
        self.assertIs(network.NetworkRuntime, object)

    def test_state_file_contains_no_raw_identifier(self):
        self.recovery.tick()
        self.assertNotIn('1234567890123456789', self.recovery.file.read_text())
        self.assertEqual(self.recovery.file.stat().st_mode & 0o777, 0o600)

    def test_factory_gsf_database_supported_before_gms_migration(self):
        recovery = GoogleCacheRecovery(self.runtime, self.directory.name)
        recovery.shell = Mock(side_effect=['', 'android_id|1234567890123456789\nuncertified_status|3', '', ''])
        value = recovery.snapshot()
        self.assertEqual(value['gsfIdSha256'], IDENTITY)
        self.assertEqual(value['legacyStatus'], '3')
        self.assertEqual(value['caches'], {})

    def test_current_gms_database_takes_precedence(self):
        recovery = GoogleCacheRecovery(self.runtime, self.directory.name)
        recovery.shell = Mock(side_effect=['android_id|1234567890123456789\nuncertified_status|1', '', ''])
        self.assertEqual(recovery.snapshot()['legacyStatus'], '1')
        self.assertEqual(recovery.shell.call_count, 3)


if __name__ == '__main__': unittest.main()
