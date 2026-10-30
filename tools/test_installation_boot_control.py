import importlib.util
from pathlib import Path
import unittest
import sys
import json
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_computer_runtime import RuntimeTests, runtime

root = Path(__file__).resolve().parents[1]/'deploy/windows-computer'
spec = importlib.util.spec_from_file_location('installation_boot', root/'installation_boot.py')
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootQmp:
    def __init__(self, running=False, index=0, lose_reply=False):
        self.running, self.index, self.lose_reply = running, index, lose_reply
        self.calls = []

    def send(self, command, arguments=None):
        self.calls.append((command, arguments))
        if command == 'query-status':
            return {'running': self.running, 'status': 'running' if self.running else 'prelaunch'}
        if command == 'qom-get':
            return self.index
        if command == 'qom-set':
            assert arguments == {'path': '/machine/peripheral/installer-device', 'property': 'bootindex', 'value': 2}
            self.index = 2
            if self.lose_reply:
                raise RuntimeError('lost reply')
            return {}
        if command == 'cont':
            self.running = True
            if self.lose_reply:
                raise RuntimeError('lost cont reply')
            return {}
        raise AssertionError('Unexpected QMP mutation: '+command)


class InstallationBootTests(unittest.TestCase):
    def test_prepares_next_reset_without_resetting_or_ejecting_guest(self):
        qmp = BootQmp()
        boot.prepare_disc_boot(qmp)
        self.assertEqual(qmp.index, 2)
        self.assertEqual([c for c, _ in qmp.calls].count('qom-set'), 1)
        boot.prepare_disc_boot(qmp)
        self.assertEqual([c for c, _ in qmp.calls].count('qom-set'), 1)

    def test_lost_reply_is_reconciled_and_live_or_mismatched_guest_is_rejected(self):
        qmp = BootQmp(lose_reply=True)
        boot.prepare_disc_boot(qmp)
        self.assertEqual(qmp.index, 2)
        for qmp in (BootQmp(running=True), BootQmp(index=1)):
            with self.assertRaises(RuntimeError):
                boot.prepare_disc_boot(qmp)
            self.assertFalse(any(c == 'qom-set' for c, _ in qmp.calls))


class InstallationCommandTests(unittest.TestCase):
    setUp = RuntimeTests.setUp
    command = RuntimeTests.command
    prepare = RuntimeTests.prepare

    def test_stopped_legacy_adoption_preserves_original_disk_identity(self):
        self.prepare()
        original = runtime.storage_identity(self.c)
        before = {p.name: p.read_bytes() for p in self.work.iterdir() if p.is_file()}
        self.c.update(runId='44444444-4444-4444-8444-444444444444', generation=1)
        config = self.root/'config'; config.mkdir()
        control = self.root/'installation-control'; control.mkdir()
        unmanaged = boot.InstallationLaunch(self.c, config, control, runtime.atomic_json)
        self.assertFalse(unmanaged.managed_media)
        request = {k: self.c[k] for k in ('computerId','ownerId','volumeId','runId','generation')}
        request.update(revision=1, digest='sha256:'+'a'*64, bootRequestId=None)
        runtime.atomic_json(config/'installation-request.json', request)
        adopted = boot.InstallationLaunch(self.c, config, control, runtime.atomic_json)
        self.assertTrue(adopted.managed_media)
        self.assertEqual(self.c['schemaVersion'], 1)
        self.assertEqual(runtime.storage_identity(self.c), original)
        args = runtime.qemu_args(adopted.config, self.work, control, managed_media=adopted.managed_media)
        self.assertTrue(any('/media/installer/' in arg for arg in args))
        runtime.verify_storage(self.c, self.work)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.work.iterdir() if p.is_file()})

    def test_disc_boot_is_paused_and_uses_only_bootindex(self):
        self.c.update(schemaVersion=2, osFamily='linux', architecture='aarch64', driverDigest=None)
        args = runtime.qemu_args(self.c, self.work, self.root/'control', disc_boot=True)
        self.assertIn('-S', args)
        self.assertNotIn('-boot', args)
        self.assertIn('usb-storage,id=installer-device,drive=installer,removable=on,bootindex=0', args)
        self.assertTrue(any('nvme,drive=system' in a and 'bootindex=1' in a for a in args))
        self.c['mediaDigest'] = None
        with self.assertRaises(ValueError):
            runtime.qemu_args(self.c, self.work, self.root/'control', disc_boot=True)

    def test_optical_side_command_binds_identity_and_never_rewrites_guest_data(self):
        self.c.update(schemaVersion=2, osFamily='linux', architecture='aarch64', mediaDigest=None, driverDigest=None)
        self.prepare()
        self.c.update(runId='44444444-4444-4444-8444-444444444444', generation=1)
        control = self.work/'control'
        control.mkdir()
        (self.work/'system.qcow2').write_bytes(b'user installed system')
        before = {p.name: p.read_bytes() for p in self.work.iterdir() if p.is_file()}
        class Qmp:
            closed = False
            def close(self): self.closed = True
        qmp = Qmp()
        calls = []
        class Drive:
            def __init__(self, instance): assert instance is qmp
            def inspect(self): return {'digest': None, 'locked': False, 'trayOpen': True}
            def change(self, digest): calls.append(digest); return {'digest': digest, 'locked': False, 'trayOpen': False}
        request = {k:self.c[k] for k in ('computerId','ownerId','runId','generation')}
        digest = 'sha256:'+'a'*64
        result = runtime.optical_command(self.c,self.work,control,'optical-change',{**request,'digest':digest},
            qmp_factory=lambda _:qmp,drive_factory=Drive)
        self.assertEqual(result['optical']['digest'], digest)
        self.assertTrue(qmp.closed)
        for bad in ({**request,'digest':'/host/system.qcow2'}, {**request,'digest':None,'generation':True},
                    {**request,'digest':None,'runId':'55555555-5555-4555-8555-555555555555'}):
            with self.assertRaises(ValueError):
                runtime.optical_command(self.c,self.work,control,'optical-change',bad,qmp_factory=lambda _:qmp,drive_factory=Drive)
        self.assertEqual(calls,[digest])
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.work.iterdir() if p.is_file()})


class InstallationLaunchJournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {'schemaVersion': 2, 'computerId':'11111111-1111-4111-8111-111111111111',
            'ownerId':'22222222-2222-4222-8222-222222222222', 'volumeId':'33333333-3333-4333-8333-333333333333',
            'runId':'44444444-4444-4444-8444-444444444444', 'generation':1, 'mediaDigest':None}
        self.request = {k:v for k,v in self.config.items() if k not in ('schemaVersion','mediaDigest')}
        self.request.update(revision=2, digest='sha256:'+'a'*64, bootRequestId='55555555-5555-4555-8555-555555555555')
        (self.root/'installation-request.json').write_text(json.dumps(self.request))

    def launch(self, write=runtime.atomic_json):
        return boot.InstallationLaunch(self.config,self.root,self.root,write)

    def test_consumed_request_does_not_rearm_after_lost_cont_reply(self):
        launch=self.launch()
        self.assertTrue(launch.disc_boot)
        self.assertIsNone(self.config['mediaDigest'])
        qmp=BootQmp(lose_reply=True)
        launch.release(qmp)
        self.assertEqual(json.loads((self.root/'installation-boot.json').read_text())['state'],'consumed')
        replay=self.launch()
        self.assertFalse(replay.disc_boot)
        replay.release(qmp)
        self.assertEqual([c for c,_ in qmp.calls].count('cont'),1)
        self.assertEqual(replay.config['mediaDigest'],self.request['digest'])

    def test_failed_journal_prevents_cpu_release_and_uncertain_record_prevents_restart(self):
        qmp=BootQmp()
        def broken(*_): raise OSError('journal unavailable')
        with self.assertRaises(OSError): self.launch(broken).release(qmp)
        self.assertFalse(qmp.running)
        launch=self.launch()
        runtime.atomic_json(launch.path,{**launch.record,'state':'armed'})
        with self.assertRaisesRegex(RuntimeError,'boot_unconfirmed'): self.launch()

    def test_foreign_or_unmounted_boot_request_rejected_before_launch(self):
        for changed in ({'runId':'66666666-6666-4666-8666-666666666666'}, {'digest':None}, {'generation':True}):
            (self.root/'installation-request.json').write_text(json.dumps({**self.request,**changed}))
            with self.assertRaises(ValueError): self.launch()

    def test_post_release_ack_failure_keeps_guest_alive_without_rearming(self):
        def write(path, value):
            if value['state'] == 'consumed': raise OSError('journal temporarily unavailable')
            runtime.atomic_json(path, value)
        qmp=BootQmp()
        launch=self.launch(write)
        launch.release(qmp)
        self.assertTrue(qmp.running)
        self.assertTrue(launch.confirmation_pending)
        self.assertFalse(launch.disc_boot)
        launch.release(qmp)
        self.assertEqual([c for c,_ in qmp.calls].count('cont'),1)
        self.assertEqual(json.loads(launch.path.read_text())['state'],'armed')
        with self.assertRaisesRegex(RuntimeError,'boot_unconfirmed'): self.launch()


del RuntimeTests  # Fixture reuse only; do not collect unrelated runtime tests.


if __name__ == '__main__':
    unittest.main()
