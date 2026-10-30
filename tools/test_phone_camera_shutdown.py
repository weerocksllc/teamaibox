"""A camera supervisor must not make a live Android VM invisible to shutdown."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

source=Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish/phone_camera_lifecycle_runtime.py'
if not source.exists():source=Path('/validation/phone_camera_lifecycle_runtime.py')

class ShutdownTests(unittest.TestCase):
    def module(self,rows):
        fake=types.ModuleType('phone_runtime_base');fake.shutdown_process_summary=lambda:rows
        spec=importlib.util.spec_from_file_location('camera_shutdown_under_test',source)
        value=importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,{'phone_runtime_base':fake}):spec.loader.exec_module(value)
        return value

    def test_supervisor_child_counts_until_vm_exits(self):
        rows=[dict(pid=123,role='run',parentRole='other',controlSockets=['crosvm_control.sock'])]
        module=self.module(rows)
        with tempfile.TemporaryDirectory() as folder:
            proc=Path(folder);(proc/'123').mkdir();(proc/'90').mkdir()
            (proc/'123/stat').write_text('123 (crosvm) S 90 2 3')
            (proc/'90/cmdline').write_bytes(b'python3\0/opt/teamaibox/phone_camera_crosvm.py\0run\0--socket=/tmp/crosvm_control.sock\0')
            self.assertEqual(module.android_processes(proc),[123])
            rows.clear()
            self.assertEqual(module.android_processes(proc),[])

    def test_other_python_and_access_point_are_not_android(self):
        rows=[dict(pid=123,role='run',parentRole='other',controlSockets=['crosvm_control.sock']),
              dict(pid=124,role='run',parentRole='process_restart',controlSockets=['ap_control.sock'])]
        module=self.module(rows)
        with tempfile.TemporaryDirectory() as folder:
            proc=Path(folder);(proc/'123').mkdir();(proc/'90').mkdir()
            (proc/'123/stat').write_text('123 (crosvm) S 90 2 3')
            (proc/'90/cmdline').write_bytes(b'python3\0/unrelated.py\0run\0')
            self.assertEqual(module.android_processes(proc),[])

    def test_legacy_parent_and_exited_supervisor(self):
        rows=[dict(pid=123,role='run',parentRole='process_restart',controlSockets=['crosvm_control.sock']),
              dict(pid=124,role='run',parentRole='other',controlSockets=['crosvm_control.sock'])]
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(self.module(rows).android_processes(Path(folder)),[123])

if __name__=='__main__':unittest.main()
