"""Linux process tests: reset code, helper lifetime and clean second start."""
import importlib.util
import os
from pathlib import Path
import signal
import sys
import tempfile
import types
import unittest

sys.modules.setdefault('phone_camera_crosvm_base', types.SimpleNamespace(media_arguments=lambda a:(a,True),REAL='',BACKEND='',DIRECTORY=Path('/tmp'),SOCKET=Path('/tmp/x')))
source = Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish/phone_camera_vm_supervisor.py'
if not source.exists(): source = Path('/validation/phone_camera_vm_supervisor.py')
spec = importlib.util.spec_from_file_location('supervisor', source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

HELPER = "import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); time.sleep(30)"


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux lifecycle')
class LifecycleTests(unittest.TestCase):
    def test_rebound_listener_is_removed_before_second_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'camera.sock'
            # Mirrors a backend recreating its listener after a VM disconnect.
            helper="import os,signal,socket,sys,time;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);signal.signal(signal.SIGUSR1,lambda *_:(s.close(),os.unlink(sys.argv[1]),globals().update(s=socket.socket(socket.AF_UNIX)),s.bind(sys.argv[1])));open(sys.argv[2],'w').write(str(os.getpid()));time.sleep(30)"
            pid=Path(tmp)/'helper.pid'
            vm="import os,signal,sys,time;os.kill(int(open(sys.argv[1]).read()),signal.SIGUSR1);time.sleep(.2);sys.exit(33)"
            for _ in range(2):
                result=module.supervise([([sys.executable,'-c',helper,str(path),str(pid)],'helper.log')],
                    [sys.executable,'-c',vm,str(pid)],[path],Path(tmp))
                self.assertEqual(result,33);self.assertFalse(path.exists())

    def test_existing_or_non_socket_paths_are_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'camera.sock';path.write_text('not ours')
            with self.assertRaisesRegex(RuntimeError,'camera_source_path_occupied'):
                module.supervise([],['must-not-run'],[path],Path(tmp))
            self.assertEqual(path.read_text(),'not ours')

    def test_reset_and_second_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'camera.sock'
            commands=[([sys.executable,'-c',HELPER,str(path)],'helper.log')]
            for _ in range(2):
                result=module.supervise(commands,[sys.executable,'-c','import sys;sys.exit(33)'],[path],Path(tmp))
                self.assertEqual(result,33)
                self.assertFalse(path.exists())

    def test_vm_group_cannot_kill_supervisor(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'camera.sock'
            commands=[([sys.executable,'-c',HELPER,str(path)],'helper.log')]
            result=module.supervise(commands,[sys.executable,'-c','import os,signal;os.killpg(os.getpgrp(),signal.SIGKILL)'],[path],Path(tmp))
            self.assertEqual(result,137)
            self.assertFalse(path.exists())

    def test_helper_start_failure_does_not_launch_vm(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'camera.sock'
            with self.assertRaisesRegex(RuntimeError,'camera_source_not_ready'):
                module.supervise([([sys.executable,'-c','raise SystemExit(1)'],'helper.log')],['must-not-run'],[path],Path(tmp))


if __name__=='__main__':unittest.main()
