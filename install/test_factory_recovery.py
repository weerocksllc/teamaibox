import hashlib
from pathlib import Path
import tempfile
import unittest

from offline_common import InstallError, read_json, write_json
from factory_recovery import activate_helpers, argument, install_files, unit, namespace_definitions


class RecoveryTests(unittest.TestCase):
    def test_namespace_upgrade_is_additive_and_enables_only_timer(self):
        with tempfile.TemporaryDirectory() as temp:
            root, units = Path(temp) / 'installation', Path(temp) / 'units'
            adapter = root / 'runtime/tools/restore_appliance_namespace.py'
            adapter.parent.mkdir(parents=True); adapter.write_text('# fixture')
            units.mkdir()
            write_json(root / 'recovery-units.json', dict(installationId='new', files={'existing.service': 'preserved'}))
            files = namespace_definitions(root)
            calls = []
            install_files(root, 'new', files, unit_root=units, command=calls.append)
            self.assertEqual(read_json(root / 'recovery-units.json')['files']['existing.service'], 'preserved')
            self.assertEqual(calls[-1], ['systemctl', 'enable', 'teamaibox-namespace-recovery.timer'])
            self.assertIn('OnUnitInactiveSec=15s', files['teamaibox-namespace-recovery.timer'])
            self.assertNotIn('RemainAfterExit', files['teamaibox-namespace-recovery.service'])
            self.assertNotIn('Restart=', files['teamaibox-namespace-recovery.service'])
            self.assertIn('Requisite=docker.service', files['teamaibox-namespace-recovery.service'])
            self.assertNotIn('Requires=docker.service', files['teamaibox-namespace-recovery.service'])
            calls.clear()
            install_files(root, 'new', files, unit_root=units, check=True, command=calls.append)
            self.assertEqual(calls, [['systemctl', 'is-enabled', 'teamaibox-namespace-recovery.timer']])

    def test_new_installation_starts_namespace_recovery_timer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = ('teamaibox-guest-devices.service', 'teamaibox-phone-storage.service',
                     'teamaibox-network-identity.timer', 'teamaibox-namespace-recovery.timer')
            write_json(root / 'recovery-units.json', dict(installationId='new', files={n: 'digest' for n in names}))
            calls = []
            activate_helpers(root, 'new', command=lambda a, **k: calls.append(a))
            self.assertIn('teamaibox-namespace-recovery.timer', calls[0])

    def test_first_install_starts_only_its_registered_helpers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = ('teamaibox-guest-devices.service', 'teamaibox-phone-storage.service',
                     'teamaibox-phone-camera.service', 'teamaibox-network-identity.timer')
            write_json(root / 'recovery-units.json', dict(installationId='new', files={n: 'digest' for n in names}))
            calls = []
            activate_helpers(root, 'new', command=lambda a, **k: calls.append(a))
            self.assertEqual(calls[0], ['systemctl', 'start', *names])
            self.assertEqual(calls[-1], ['systemctl', 'is-active', *names])
            self.assertFalse(any('docker.service' in c or 'restart' in c for c in calls))
            calls.clear()
            activate_helpers(root, 'new', check=True, command=lambda a, **k: calls.append(a))
            self.assertEqual(calls, [['systemctl', 'is-active', *names]])

    def test_unknown_helper_installation_is_not_started(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_json(root / 'recovery-units.json', dict(installationId='original', files={}))
            calls = []
            with self.assertRaisesRegex(InstallError, 'identity'):
                activate_helpers(root, 'new', command=lambda a, **k: calls.append(a))
            self.assertFalse(calls)

    def test_unit_paths_are_quoted_and_specifiers_escaped(self):
        self.assertEqual(argument('/srv/team box/100%/file'), '"/srv/team box/100%%/file"')
        with self.assertRaises(InstallError):
            argument('/srv/evil\nExecStart=bad')
        text = unit(['/usr/bin/python3', '/srv/new/runtime/tools/restore.py'], description='Local restore',
                    environment={'PLATFORM_APPLIANCE_NODE_ID': 'fixture'})
        self.assertIn('Restart=on-failure', text)
        self.assertNotIn('restart docker', text)

    def test_cannot_publish_a_docker_dropin_even_when_no_file_exists(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(InstallError, 'only write Team AI Box'):
                install_files(root, 'new', {'docker.service.d/teamaibox.conf': 'invalid'},
                              unit_root=root / 'systemd', command=lambda _: self.fail('called systemctl'))
            self.assertFalse((root / 'recovery-units.json').exists())

    def test_existing_unit_is_not_adopted_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root, units = Path(temp) / 'new', Path(temp) / 'systemd'
            root.mkdir(); units.mkdir()
            (units / 'local.service').write_text('existing service')
            calls = []
            with self.assertRaisesRegex(InstallError, 'preserved'):
                install_files(root, 'new', {'local.service': 'replacement'}, unit_root=units, command=calls.append)
            self.assertEqual((units / 'local.service').read_text(), 'existing service')
            self.assertFalse(calls)
            self.assertFalse((root / 'recovery-units.json').exists())

    def test_interrupted_publication_resumes_and_check_is_read_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root, units = Path(temp) / 'new', Path(temp) / 'systemd'
            root.mkdir(); units.mkdir()
            text = unit(['/bin/true'], description='Fixture only')
            files = {'local.service': text}
            write_json(root / 'recovery-units.json', {'installationId': 'new', 'files': {
                name: hashlib.sha256(raw.encode()).hexdigest() for name, raw in files.items()}})
            calls = []
            install_files(root, 'new', files, unit_root=units, command=calls.append)
            self.assertEqual((units / 'local.service').read_text(), text)
            self.assertFalse(any('restart' in call or '--now' in call for call in calls))
            before = (units / 'local.service').stat().st_mtime_ns
            calls.clear()
            install_files(root, 'new', files, unit_root=units, check=True, command=calls.append)
            self.assertEqual(before, (units / 'local.service').stat().st_mtime_ns)
            self.assertEqual(calls, [['systemctl', 'is-enabled', 'local.service']])

    def test_drift_refuses_all_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root, units = Path(temp) / 'new', Path(temp) / 'systemd'
            root.mkdir(); units.mkdir()
            files = {'a.service': 'a', 'b.service': 'b'}
            install_files(root, 'new', files, unit_root=units, command=lambda _: '')
            (units / 'b.service').write_text('changed outside installer')
            calls = []
            with self.assertRaisesRegex(InstallError, 'preserved'):
                install_files(root, 'new', files, unit_root=units, command=calls.append)
            self.assertFalse(calls)


if __name__ == '__main__':
    unittest.main()
