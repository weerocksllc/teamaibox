"""Only installation-media additions; temporary files, no appliance/guest data."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_computer_runtime import RuntimeTests, config, runtime

spec = importlib.util.spec_from_file_location('optical_drive', Path(__file__).resolve().parents[1] / 'deploy/windows-computer/optical_drive.py')
optical = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optical)


class InstallationIdentityTests(unittest.TestCase):
    # Reuse fixture helpers, not the unrelated audio/shutdown test suite.
    setUp = RuntimeTests.setUp
    command = RuntimeTests.command
    prepare = RuntimeTests.prepare

    def test_optical_operations_use_a_listener_separate_from_lifetime_monitor(self):
        self.c.update(schemaVersion=2, osFamily='linux', architecture='aarch64', mediaDigest=None,
                      driverDigest=None, tpmId=None, tpmPpi=False)
        self.prepare()
        self.c.update(runId='00000000-0000-4000-8000-000000000001', generation=1)
        args=runtime.qemu_args(self.c,self.work,Path('/control'))
        listeners=[args[i+1] for i,v in enumerate(args) if v=='-qmp']
        self.assertEqual(listeners,['unix:/control/qmp.sock,server=on,wait=off',
                                    'unix:/control/qmp-optical.sock,server=on,wait=off'])
        paths=[]
        class Monitor:
            def close(self): pass
        class Drive:
            def __init__(self,qmp): pass
            def inspect(self): return {'digest':None,'locked':False,'trayOpen':False}
        with tempfile.TemporaryDirectory() as directory:
            control=Path(directory)
            request={k:self.c[k] for k in ('computerId','ownerId','runId','generation')}
            runtime.optical_command(self.c,self.work,control,'optical-inspect',request,
                qmp_factory=lambda path:(paths.append(path) or Monitor()),drive_factory=Drive)
            self.assertEqual(paths,[control/'qmp-optical.sock'])

    def test_new_identity_keeps_disk_firmware_tpm_when_media_changes(self):
        self.c.update(schemaVersion=2, osFamily='windows', architecture='aarch64', mediaDigest=None)
        runtime.validate_config(self.c)
        self.prepare()
        (self.work/'system.qcow2').write_bytes(b'installed user data')
        (self.work/'VARS.fd').write_bytes(b'guest variables')
        (self.work/'tpm/state').write_bytes(b'guest secret state')
        names = ['identity.json', 'system.qcow2', 'VARS.fd', 'tpm/state']
        before = {name: ((self.work/name).stat().st_ino, (self.work/name).read_bytes()) for name in names}
        for media in ['sha256:'+'e'*64, 'sha256:'+'f'*64, None]:
            self.c['mediaDigest'] = media
            self.prepare()
            runtime.verify_storage(self.c, self.work)
            self.assertEqual(before, {name: ((self.work/name).stat().st_ino, (self.work/name).read_bytes()) for name in names})
        self.assertEqual(self.creates, 1)
        for key in ['computerId', 'ownerId', 'volumeId', 'firmwareId', 'tpmId', 'osFamily']:
            changed = {**self.c, key: 'foreign'}
            with self.assertRaisesRegex(RuntimeError, 'storage_identity'):
                runtime.prepare_guest(changed, self.work, self.firmware, self.command)

    def test_legacy_media_and_schema_identity_cannot_be_reinterpreted(self):
        self.prepare()
        original = (self.work/'identity.json').read_bytes()
        for changed in [{**self.c, 'mediaDigest': None},
                        {**self.c, 'schemaVersion': 2, 'osFamily': 'windows', 'architecture': 'aarch64'}]:
            with self.assertRaisesRegex(RuntimeError, 'storage_identity'):
                runtime.prepare_guest(changed, self.work, self.firmware, self.command)
        self.assertEqual(original, (self.work/'identity.json').read_bytes())
        self.assertEqual(self.creates, 1)

    def test_empty_linux_has_no_windows_or_driver_disc_dependency(self):
        self.c.update(schemaVersion=2, osFamily='linux', architecture='aarch64', mediaDigest=None,
                      driverDigest=None, tpmId=None, tpmPpi=False)
        runtime.validate_config(self.c)
        args = runtime.qemu_args(self.c, self.work, Path('/control'))
        text = ' '.join(args)
        self.assertNotIn('windows.iso', text)
        self.assertNotIn('virtio.iso', text)
        self.assertNotIn('drive=drivers', text)
        self.assertNotIn('3389', text)
        self.assertIn('if=none,id=installer,media=cdrom', args)
        self.assertIn('removable=on', text)
        self.assertNotIn('-boot', args)  # Do not mix bootindex with boot once.
        self.prepare()
        runtime.verify_storage(self.c, self.work)

    def test_schema_and_path_validation(self):
        c = {**self.c, 'schemaVersion': 2, 'osFamily': 'linux', 'architecture': 'aarch64', 'mediaDigest': None, 'driverDigest': None}
        runtime.validate_config(c)
        for change in [{'architecture': 'x86_64'}, {'schemaVersion': True}, {'osFamily': 'other'}, {'mediaDigest': '/host/file.iso'}]:
            with self.assertRaises(ValueError):
                runtime.validate_config({**c, **change})
        with self.assertRaises(ValueError):
            runtime.installer_path('../disk.qcow2')


class FakeQmp:
    def __init__(self):
        self.file = None
        self.locked = False
        self.lost_reply = False
        self.calls = []
        self.device = 'installer'
        self.qdev = '/machine/peripheral/installer-device/installer-device.0/legacy[0]'

    def send(self, command, arguments=None):
        self.calls.append((command, arguments))
        if command == 'query-block':
            return [{'device': self.device, 'qdev': self.qdev, 'removable': True, 'locked': self.locked,
                     **({'inserted': {'file': self.file}} if self.file else {})}]
        if command == 'blockdev-change-medium':
            self.file = arguments['filename']
        elif command == 'eject':
            self.file = None
        else:
            raise AssertionError(command)
        if self.lost_reply:
            raise RuntimeError('computer_qmp_reply_timeout')
        return {}


class OpticalDriveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.qmp = FakeQmp()
        self.drive = optical.OpticalDrive(self.qmp, self.root)
        self.digest = 'sha256:' + hashlib.sha256(b'iso fixture').hexdigest()
        (self.root/(self.digest[7:]+'.iso')).write_bytes(b'iso fixture')

    def test_mount_eject_and_lost_reply_reconcile_without_replay(self):
        self.qmp.lost_reply = True
        self.assertEqual(self.drive.change(self.digest)['digest'], self.digest)
        self.drive.change(self.digest)
        commands = [call for call in self.qmp.calls if call[0] != 'query-block']
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][1]['force'], False)
        self.assertEqual(commands[0][1]['id'], '/machine/peripheral/installer-device/installer-device.0/legacy[0]')
        self.assertEqual(commands[0][1]['read-only-mode'], 'read-only')
        self.assertIsNone(self.drive.change(None)['digest'])
        self.assertNotIn('system_reset', [call[0] for call in self.qmp.calls])

    def test_guest_lock_prevents_mount_or_eject(self):
        self.qmp.locked = True
        with self.assertRaisesRegex(RuntimeError, 'media_locked'):
            self.drive.change(self.digest)
        self.assertTrue(all(call[0] == 'query-block' for call in self.qmp.calls))

    def test_wrong_device_or_unexpected_path_never_changes_any_disk(self):
        self.qmp.device = 'system'
        with self.assertRaisesRegex(RuntimeError, 'runtime_unsupported'):
            self.drive.change(self.digest)
        self.qmp.device = 'installer'
        self.qmp.file = '/guest/system.qcow2'
        with self.assertRaisesRegex(RuntimeError, 'state_unknown') as caught:
            self.drive.change(self.digest)
        self.assertNotIn('/guest', str(caught.exception))
        self.assertTrue(all(call[0] == 'query-block' for call in self.qmp.calls))

    def test_digest_mismatch_and_symlink_rejected_before_qmp_mutation(self):
        path = self.root/(self.digest[7:]+'.iso')
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'digest_mismatch'):
            self.drive.change(self.digest)
        path.unlink()
        path.symlink_to(self.root/'absent')
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            self.drive.change(self.digest)
        self.assertTrue(all(call[0] == 'query-block' for call in self.qmp.calls))


# Avoid unittest collecting the imported legacy suite.
del RuntimeTests

if __name__ == '__main__':
    unittest.main()
