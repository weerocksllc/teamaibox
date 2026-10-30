import json
import unittest
from boot_container_memory import container_memory_rows
from recover_ai_workers import public_error


class MemorySampleTests(unittest.TestCase):
    def test_restarting_pid_zero_is_not_read(self):
        items = [{'Id': 'agent', 'State': {'Running': True, 'Restarting': True, 'Pid': 0}},
                 {'Id': 'model', 'State': {'Running': True, 'Pid': 42}}]
        def command(args): return 'agent model' if args[1] == 'ps' else json.dumps(items)
        rows = container_memory_rows(command, lambda c: c['Id'])
        self.assertEqual(rows, ['model'])

    def test_exit_race_resamples_the_whole_set(self):
        reads = []
        def command(args):
            return 'model' if args[1] == 'ps' else json.dumps([{'Id': 'model', 'State': {'Running': True, 'Pid': 42}}])
        def row(c):
            reads.append(c['Id'])
            if len(reads) == 1: raise FileNotFoundError('gone')
            return {'current': 1024}
        self.assertEqual(container_memory_rows(command, row, lambda _: None), [{'current': 1024}])
        self.assertEqual(len(reads), 2)

    def test_continuous_churn_is_retryable_not_silently_undercounted(self):
        def command(args): return 'model' if args[1] == 'ps' else json.dumps([{'State': {'Running': True, 'Pid': 42}}])
        def row(_): raise FileNotFoundError('gone')
        with self.assertRaisesRegex(RuntimeError, 'boot_resource_snapshot_unstable'):
            container_memory_rows(command, row, lambda _: None)

    def test_diagnostics_are_actionable_without_private_paths(self):
        self.assertEqual(public_error(FileNotFoundError('/private')), 'boot_resource_file_unavailable')
        self.assertEqual(public_error(RuntimeError('{"code":"boot_memory_pressure","rejectedSnapshot":{}}')), 'boot_memory_pressure')
        self.assertNotIn('/private', public_error(Exception('/private')))


if __name__ == '__main__': unittest.main()
