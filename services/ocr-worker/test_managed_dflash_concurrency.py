"""CPU-only deterministic startup/concurrent-prepare regressions; no model loads."""
import importlib.util
import io
from pathlib import Path
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('dflash_concurrency', Path(__file__).with_name('managed_dflash_server.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PrepareConcurrencyTests(unittest.TestCase):
    @staticmethod
    def process(pid=1000):
        process = mock.Mock(pid=pid)
        process.poll.return_value = None
        process.stdout = None
        return process

    def test_cancelled_waiter_does_not_accept_or_stop_replacement_engine(self):
        supervisor = worker.EngineSupervisor()
        original, replacement = self.process(), self.process(1001)
        ready_check = threading.Event()
        continue_check = threading.Event()
        errors = []

        def health():
            ready_check.set()
            self.assertTrue(continue_check.wait(2))
            return True

        def prepare():
            try:
                supervisor.prepare()
            except RuntimeError as error:
                errors.append(str(error))

        with mock.patch.object(supervisor, 'snapshot_ready', return_value=True), \
             mock.patch.object(supervisor, '_ready', side_effect=health), \
             mock.patch.object(supervisor, '_stop_locked') as stop, \
             mock.patch.object(worker.subprocess, 'Popen', return_value=original):
            waiter = threading.Thread(target=prepare)
            waiter.start()
            self.assertTrue(ready_check.wait(2))
            with supervisor.lock:
                supervisor.process = replacement
                supervisor.preparing_process = replacement
            continue_check.set()
            waiter.join(2)
            self.assertFalse(waiter.is_alive())
            self.assertEqual(errors, ['HunyuanOCR DFlash engine preparation was cancelled'])
            self.assertIs(supervisor.process, replacement)
            self.assertEqual(stop.call_count, 1)

    def test_joiner_keeps_original_deadline_and_does_not_start_another_process(self):
        supervisor = worker.EngineSupervisor()
        process = self.process()
        supervisor.process = supervisor.preparing_process = process
        supervisor.prepare_deadline = 100
        with mock.patch.object(supervisor, 'snapshot_ready', return_value=True), \
             mock.patch.object(supervisor, '_ready', return_value=False), \
             mock.patch.object(worker.time, 'monotonic', return_value=101), \
             mock.patch.object(supervisor, '_stop_locked') as stop, \
             mock.patch.object(worker.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                supervisor.prepare()
            spawn.assert_not_called()
            stop.assert_called_once()
            self.assertEqual(supervisor.prepare_deadline, 100)
            self.assertEqual(supervisor.startup_status()['reason'], 'engine_prepare_timeout')

    def test_failed_startup_records_exit_without_inventing_oom(self):
        supervisor = worker.EngineSupervisor()
        process = self.process()
        process.poll.return_value = 1
        with mock.patch.object(supervisor, 'snapshot_ready', return_value=True), \
             mock.patch.object(supervisor, '_stop_locked'), \
             mock.patch.object(worker.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(RuntimeError, 'exited while preparing'):
                supervisor.prepare()
        self.assertEqual(supervisor.startup_status(), {'phase': 'failed', 'exitCode': 1, 'reason': None})

    def test_diagnostics_drain_large_output_but_only_retain_fixed_error_class(self):
        supervisor = worker.EngineSupervisor()
        process = self.process()
        # Split the marker across reads, surround it with private-looking text,
        # and continue well beyond the bounded matching window.
        raw = b'x' * 4090 + b'CUDA out of memory /private/secret-document.png\n' + b'y' * 100000
        stream = io.BytesIO(raw)
        process.stdout = stream
        supervisor.process = supervisor.preparing_process = process
        supervisor._drain_diagnostics(process)
        self.assertTrue(stream.closed)
        self.assertEqual(supervisor.startup_status()['reason'], 'cuda_memory_exhausted')
        self.assertNotIn('secret', str(vars(supervisor)))
        self.assertNotIn('private', str(supervisor.startup_status()))

    def test_old_diagnostic_reader_cannot_change_new_startup(self):
        supervisor = worker.EngineSupervisor()
        old, current = self.process(), self.process(1001)
        old.stdout = io.BytesIO(b'CUDA out of memory')
        supervisor.process = supervisor.preparing_process = current
        supervisor._drain_diagnostics(old)
        self.assertIsNone(supervisor.startup_status()['reason'])

    def test_concurrent_prepare_joins_the_loading_engine_without_restarting_it(self):
        supervisor = worker.EngineSupervisor()
        started = threading.Event()
        second_checked = threading.Event()
        ready = threading.Event()
        processes = []
        results, errors = [], []

        def spawn(*_args, **_kwargs):
            process = mock.Mock(pid=1000 + len(processes))
            process.poll.return_value = None
            process.stdout = None
            processes.append(process)
            started.set()
            return process

        def health():
            if threading.current_thread().name == 'second':
                second_checked.set()
            return ready.is_set()

        def prepare():
            try:
                results.append(supervisor.prepare())
            except Exception as error:
                errors.append(type(error).__name__)

        with mock.patch.object(supervisor, 'snapshot_ready', return_value=True), \
             mock.patch.object(supervisor, '_ready', side_effect=health), \
             mock.patch.object(supervisor, '_stop_locked') as stop, \
             mock.patch.object(worker.subprocess, 'Popen', side_effect=spawn):
            first = threading.Thread(target=prepare, name='first')
            second = threading.Thread(target=prepare, name='second')
            first.start()
            self.assertTrue(started.wait(2))
            second.start()
            self.assertTrue(second_checked.wait(2))
            ready.set()
            first.join(3)
            second.join(3)
            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(results), 2)
            self.assertEqual(len(processes), 1, 'a concurrent prepare replaced the loading engine')
            self.assertEqual(stop.call_count, 1, 'only the initial pre-launch cleanup is allowed')


if __name__ == '__main__':
    unittest.main()
