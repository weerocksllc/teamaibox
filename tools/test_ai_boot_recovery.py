import copy
import tempfile
import json
import unittest
from pathlib import Path
from test_calibrated_office_boot import fixture, FakeAdapter
from recover_ai_workers import recover, BootProgress


class ClockAdapter(FakeAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.now = 0

    def monotonic(self): return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.now > 300: raise AssertionError('unexpected unbounded fixture')


class RecoveryTests(unittest.TestCase):
    def test_one_failed_start_preserves_healthy_peers_and_retries_only_failure(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter = ClockAdapter(entries, memory, running=[entries[0]['id']])
        start, failures = adapter.start, []
        def fail_once(entry):
            if entry['id'] == entries[2]['id'] and not failures:
                failures.append(entry['id']); raise RuntimeError('fixture_failed_start')
            start(entry)
        adapter.start = fail_once
        events = []
        result = recover(value, entries, adapter, lambda x, **k: events.append(copy.deepcopy(x)))
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(len(adapter.running), 6)
        self.assertFalse(any(op == 'stop' for op, _ in adapter.calls))
        self.assertEqual([cid for op, cid in adapter.calls], [entries[i]['id'] for i in (1, 3, 4, 5, 2)])
        self.assertTrue(any(e['worker-2']['phase'] == 'retrying' and e['worker-5']['phase'] == 'ready' for e in events))

    def test_health_timeout_restarts_only_affected_model(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter = ClockAdapter(entries, memory, running=[e['id'] for e in entries])
        inspect = adapter.inspect
        def unhealthy(entry):
            state = inspect(entry)
            if entry == entries[1] and not any(op == 'stop' for op, _ in adapter.calls): state['healthy'] = False
            return state
        adapter.inspect = unhealthy
        recover(value, entries, adapter, health_timeout=6)
        self.assertEqual(adapter.calls, [('stop', entries[1]['id']), ('start', entries[1]['id'])])

    def test_late_dependency_does_not_rollback_healthy_models(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter = ClockAdapter(entries, memory, running=[entries[0]['id']])
        def late(_):
            if adapter.now < 20: raise RuntimeError('boot_database_not_ready')
        adapter.wait_ready = late
        recover(value, entries, adapter)
        self.assertGreaterEqual(adapter.now, 20)
        self.assertEqual(len([x for x in adapter.calls if x[0] == 'start']), 5)
        self.assertFalse(any(x[0] == 'stop' for x in adapter.calls))

    def test_healthy_invocation_never_mutates_models(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter = ClockAdapter(entries, memory, running=[e['id'] for e in entries])
        recover(value, entries, adapter)
        self.assertEqual(adapter.calls, [])

    def test_capacity_wait_preserves_running_model_and_resumes_without_operator(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter = ClockAdapter(entries, memory, running=[entries[0]['id']])
        snapshot=adapter.snapshot
        def capacity(v):
            state=snapshot(v)
            if adapter.now < 20: state['availableBytes']=1
            return state
        adapter.snapshot=capacity
        recover(value,entries,adapter)
        self.assertGreaterEqual(adapter.now,20)
        self.assertEqual(len([x for x in adapter.calls if x[0]=='start']),5)
        self.assertFalse(any(x[0]=='stop' for x in adapter.calls))

    def test_backoff_is_capped_and_healthy_peers_are_not_restarted(self):
        value, manifest, _, memory = fixture(); entries = manifest['containers']
        adapter=ClockAdapter(entries,memory,running=[e['id'] for e in entries[1:]])
        start=adapter.start; attempts=[]
        def late(entry):
            attempts.append(adapter.now)
            if len(attempts)<5: raise RuntimeError('fixture_failed_start')
            start(entry)
        adapter.start=late
        recover(value,entries,adapter,retry_initial=5,retry_max=10)
        self.assertEqual(attempts,[0,5,15,25,35])
        self.assertEqual(adapter.calls,[('start',entries[0]['id'])])

    def test_progress_contains_only_readiness_and_is_atomic_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            writer = BootProgress('node', path)
            writer({'worker': {'phase': 'loading', 'attempts': 0}})
            self.assertEqual(json.loads(path.read_text())['workers']['worker']['phase'], 'loading')
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
            writer({'worker': {'phase': 'ready', 'attempts': 0}}, complete=True)
            self.assertEqual(json.loads(path.read_text())['status'], 'ready')


if __name__ == '__main__': unittest.main()
