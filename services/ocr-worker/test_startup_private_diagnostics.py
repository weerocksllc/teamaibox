"""Startup failure detail is bounded, private, and never captures OCR requests."""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('startup_private', Path(__file__).with_name('managed_dflash_startup_diagnostics.py'))
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

class PrivateDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)/'startup.log'
        self.patch = mock.patch.object(worker, 'STARTUP_ERROR_PATH', self.path); self.patch.start()
        self.addCleanup(self.directory.cleanup); self.addCleanup(self.patch.stop)

    def test_failed_startup_keeps_only_bounded_private_tail(self):
        s = worker.EngineSupervisor(); p = mock.Mock(stdout=io.BytesIO(b'x'*100000+b'CUDA out of memory /private/path'))
        s.preparing_process = s.startup_log_process = p
        s._drain_diagnostics(p)
        self.assertEqual(len(self.path.read_bytes()), 65536)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(s.startup_status()['reason'], 'cuda_memory_exhausted')
        self.assertNotIn('/private', str(s.startup_status()))
        self.assertFalse(s.startup_log_tail)

    def test_ready_runtime_cannot_persist_document_output(self):
        s = worker.EngineSupervisor(); p = mock.Mock(stdout=io.BytesIO(b'PRIVATE DOCUMENT CONTENT'))
        s.process = p
        s._drain_diagnostics(p)
        self.assertFalse(self.path.exists()); self.assertFalse(s.startup_log_tail)

    def test_old_reader_cannot_change_a_new_startup(self):
        s = worker.EngineSupervisor(); p = mock.Mock(stdout=io.BytesIO(b'CUDA out of memory PRIVATE'))
        s.startup_log_process = s.preparing_process = mock.Mock()
        s._drain_diagnostics(p)
        self.assertFalse(self.path.exists()); self.assertIsNone(s.startup_status()['reason'])

    def test_no_follow_of_symlink(self):
        target = Path(self.directory.name)/'protected'; target.write_bytes(b'untouched')
        self.path.symlink_to(target)
        s = worker.EngineSupervisor(); p = mock.Mock(stdout=io.BytesIO(b'startup error'))
        s.startup_log_process = p; s._drain_diagnostics(p)
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_clear_on_unload(self):
        self.path.write_bytes(b'private startup'); s = worker.EngineSupervisor()
        s.startup_log_tail.extend(b'private'); s.startup_log_process = mock.Mock()
        s.unload()
        self.assertFalse(self.path.exists()); self.assertFalse(s.startup_log_tail)
        self.assertIsNone(s.startup_log_process)

if __name__ == '__main__': unittest.main()
