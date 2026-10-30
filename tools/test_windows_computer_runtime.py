"""Product runtime unit tests; no Windows disk, KVM device or live node touched."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('windows_computer_runtime', Path(__file__).resolve().parents[1] / 'deploy/windows-computer/runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

def config():
    c = {k: str(uuid.uuid4()) for k in ('computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId', 'tpmId')}
    c.update(schemaVersion=1, runId=None, generation=0, profileId='win11-arm64-pro', runtimeImage='sha256:'+'a'*64,
             resources={'vcpus': 4, 'memoryBytes': 8*1024**3, 'diskBytes': 128*1024**3},
             firmwareCodeDigest='sha256:'+'b'*64, firmwareVarsDigest='sha256:'+hashlib.sha256(b'firmware-fixture').hexdigest(),
             mediaDigest='sha256:'+'c'*64, driverDigest='sha256:'+'d'*64, tpmPpi=True, shutdownSeconds=120)
    return c

class RuntimeTests(unittest.TestCase):
    def test_virtual_speaker_uses_only_private_monitor_source(self):
        args=runtime.qemu_args(config(), Path('/guest'), Path('/control'))
        self.assertIn('usb-audio,audiodev=monitor_audio,multi=off', args)
        self.assertIn('server=tcp:127.0.0.1:4713', args[args.index('-audiodev')+1])
        self.assertIn('set-default-source guest_output.monitor', runtime.PULSE_CONFIG)
        self.assertNotIn('udev',runtime.PULSE_CONFIG)
        self.assertNotIn('alsa',runtime.PULSE_CONFIG)

    def test_audio_failure_is_nonfatal_and_retries_without_guest_action(self):
        audio=runtime.MonitorAudio()
        self.addCleanup(audio.close)
        with patch.object(runtime.subprocess,'Popen',side_effect=OSError('missing')) as spawn:
            self.assertFalse(audio.ensure_running())
            self.assertFalse(audio.ensure_running())
            self.assertEqual(spawn.call_count,1)
            audio.retry_at=0
            self.assertFalse(audio.ensure_running())
            self.assertEqual(spawn.call_count,2)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.work, self.firmware = self.root/'guest', self.root/'firmware'
        self.work.mkdir()
        self.firmware.mkdir()
        (self.firmware/'VARS.fd').write_bytes(b'firmware-fixture')
        self.c = config()
        self.creates = 0

    def command(self, argv, **_):
        if argv[1] == 'create':
            self.assertEqual(json.loads((self.work/'identity.json').read_text())['phase'], 'initializing')
            self.creates += 1
            Path(argv[-2]).write_bytes(b'qcow-test-fixture')
            return types.SimpleNamespace(returncode=0)
        self.assertEqual(argv[1:3], ['info', '--output=json'])
        return types.SimpleNamespace(stdout=json.dumps({'format': 'qcow2', 'virtual-size': self.c['resources']['diskBytes']}))

    def prepare(self):
        runtime.prepare_guest(self.c, self.work, self.firmware, self.command)

    def test_configuration_is_closed_and_resources_are_not_lab_limits(self):
        self.c['resources'] = {'vcpus': 12, 'memoryBytes': 24*1024**3, 'diskBytes': 512*1024**3}
        self.assertEqual(runtime.validate_config(self.c), self.c)
        args = runtime.qemu_args(self.c, Path('/guest'), Path('/control'))
        self.assertEqual(args[args.index('-smp')+1], '12')
        self.assertEqual(args[args.index('-m')+1], '24576')
        self.assertEqual(args[args.index('-accel')+1], 'kvm')
        self.assertNotIn('max-seconds', ' '.join(args))
        for addition in ({'command': 'sh'}, {'password': 'private'}, {'diskPath': '/host/disk'}):
            with self.assertRaises(ValueError):
                runtime.validate_config({**self.c, **addition})

    def test_provision_replay_preserves_disk_firmware_and_tpm_bytes(self):
        self.prepare()
        (self.work/'system.qcow2').write_bytes(b'installed Windows test data')
        (self.work/'VARS.fd').write_bytes(b'guest-selected settings')
        (self.work/'tpm'/'state').write_bytes(b'persistent tpm state')
        before = {name: ((self.work/name).stat().st_ino, (self.work/name).read_bytes()) for name in ('system.qcow2', 'VARS.fd', 'tpm/state')}
        self.prepare()
        runtime.verify_storage(self.c, self.work)
        self.assertEqual(self.creates, 1)
        self.assertEqual(before, {name: ((self.work/name).stat().st_ino, (self.work/name).read_bytes()) for name in before})

    def test_ready_guest_with_missing_data_never_reinitializes(self):
        self.prepare()
        (self.work/'VARS.fd').unlink()
        with self.assertRaisesRegex(RuntimeError, 'storage_identity'):
            self.prepare()
        self.assertEqual(self.creates, 1)
        self.assertFalse((self.work/'VARS.fd').exists())

    def test_partial_never_started_creation_can_resume_without_replacing_disk(self):
        runtime.atomic_json(self.work/'identity.json', {'phase': 'initializing', 'identity': runtime.storage_identity(self.c)})
        (self.work/'system.qcow2').write_bytes(b'first creation completed disk')
        inode = (self.work/'system.qcow2').stat().st_ino
        self.prepare()
        self.assertEqual(self.creates, 0)
        self.assertEqual((self.work/'system.qcow2').stat().st_ino, inode)
        runtime.verify_storage(self.c, self.work)

    def test_foreign_or_unknown_files_are_not_adopted_or_overwritten(self):
        (self.work/'system.qcow2').write_bytes(b'unknown owner')
        with self.assertRaisesRegex(RuntimeError, 'partial_storage'):
            self.prepare()
        self.assertEqual((self.work/'system.qcow2').read_bytes(), b'unknown owner')
        self.assertEqual(self.creates, 0)

    def test_profile_or_storage_rebinding_does_not_replace_a_guest(self):
        self.prepare()
        for key in ('computerId', 'ownerId', 'volumeId', 'firmwareId', 'tpmId', 'profileId', 'mediaDigest'):
            c = copy.deepcopy(self.c)
            c[key] = 'different'
            with self.assertRaisesRegex(RuntimeError, 'storage_identity'):
                runtime.prepare_guest(c, self.work, self.firmware, self.command)
        self.assertEqual(self.creates, 1)

    def test_qmp_only_guest_shutdown_event_proves_clean_shutdown(self):
        for event, expected in [({'event':'SHUTDOWN','data':{'guest':True,'reason':'guest-shutdown'}}, True),
                                ({'event':'SHUTDOWN','data':{'guest':False,'reason':'host-signal'}}, False),
                                ({'event':'STOP'}, False)]:
            with tempfile.TemporaryDirectory(dir='/tmp') as folder:
                path = Path(folder)/'qmp.sock'
                server = socket.socket(socket.AF_UNIX)
                server.bind(str(path))
                server.listen(1)
                def respond():
                    conn, _ = server.accept()
                    with conn, conn.makefile('rwb', buffering=0) as stream:
                        stream.write(b'{"QMP":{}}\n')
                        command = json.loads(stream.readline())
                        stream.write(json.dumps({'return': {}, 'id': command['id']}).encode()+b'\n')
                        stream.write(json.dumps(event).encode()+b'\n')
                thread = threading.Thread(target=respond)
                thread.start()
                qmp = runtime.Qmp(path)
                thread.join(timeout=2)
                qmp.reader.join(timeout=2)
                self.assertEqual(qmp.clean_shutdown, expected)
                qmp.close()
                server.close()

    def test_qmp_startup_retries_after_socket_path_precedes_listener(self):
        attempts = []
        expected = object()
        def connect(path):
            attempts.append(path)
            if len(attempts) < 3:
                raise ConnectionRefusedError()
            return expected
        process = Mock()
        process.poll.return_value = None
        self.assertIs(runtime.wait_qmp('/control/qmp.sock', process, timeout=1,
                                       factory=connect, retry_interval=0), expected)
        self.assertEqual(attempts, ['/control/qmp.sock'] * 3)

    def test_qmp_startup_stops_retrying_when_qemu_exits(self):
        process = Mock()
        process.poll.return_value = 1
        with self.assertRaisesRegex(RuntimeError, 'computer_qmp_unavailable'):
            runtime.wait_qmp('/control/qmp.sock', process, timeout=1,
                             factory=lambda _: self.fail('must not connect'), retry_interval=0)

    def test_qmp_correlates_replies_while_processing_events(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as folder:
            path = Path(folder)/'qmp.sock'
            server = socket.socket(socket.AF_UNIX)
            self.addCleanup(server.close)
            server.bind(str(path))
            server.listen(1)
            def respond():
                conn, _ = server.accept()
                with conn, conn.makefile('rwb', buffering=0) as stream:
                    stream.write(b'{"QMP":{}}\n')
                    for _ in range(2):
                        command = json.loads(stream.readline())
                        stream.write(b'{"event":"POWERDOWN"}\n')
                        stream.write(b'{"return":{},"id":99999}\n')
                        stream.write(json.dumps({'return': {'command':command['execute']}, 'id': command['id']}).encode()+b'\n')
            thread = threading.Thread(target=respond)
            thread.start()
            qmp = runtime.Qmp(path)
            self.assertEqual(qmp.send('system_powerdown'), {'command':'system_powerdown'})
            thread.join(timeout=2)
            qmp.reader.join(timeout=2)
            self.assertEqual(qmp.powerdown_events, 2)
            self.assertFalse(qmp.clean_shutdown)
            self.assertEqual(qmp.pending, {})
            qmp.close()

    def test_qmp_rejection_is_not_command_acceptance_or_clean_shutdown(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as folder:
            path = Path(folder)/'qmp.sock'
            server = socket.socket(socket.AF_UNIX)
            self.addCleanup(server.close)
            server.bind(str(path))
            server.listen(1)
            def respond():
                conn, _ = server.accept()
                with conn, conn.makefile('rwb', buffering=0) as stream:
                    stream.write(b'{"QMP":{}}\n')
                    command = json.loads(stream.readline())
                    stream.write(json.dumps({'return':{}, 'id':command['id']}).encode()+b'\n')
                    command = json.loads(stream.readline())
                    stream.write(json.dumps({'error':{'class':'GenericError','desc':'private diagnostic'},'id':command['id']}).encode()+b'\n')
            thread = threading.Thread(target=respond)
            thread.start()
            qmp = runtime.Qmp(path)
            error = runtime.request_shutdown(qmp, self.root, {'runId':'test-run'})
            self.assertEqual(error, 'computer_qmp_command_rejected')
            recorded = json.loads((self.root/'shutdown-status.json').read_text())
            self.assertFalse(recorded['commandAccepted'])
            self.assertFalse(recorded['guestShutdownConfirmed'])
            self.assertNotIn('private diagnostic', json.dumps(recorded))
            thread.join(timeout=2)
            qmp.close()

    def test_unanswered_shutdown_is_reported_without_throwing_to_kill_path(self):
        qmp = Mock(clean_shutdown=False)
        qmp.send.side_effect = RuntimeError('computer_qmp_reply_timeout')
        self.assertEqual(runtime.request_shutdown(qmp, self.root, {}), 'computer_qmp_reply_timeout')
        self.assertFalse(json.loads((self.root/'shutdown-status.json').read_text())['commandAccepted'])

if __name__ == '__main__':
    unittest.main()
