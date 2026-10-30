import copy
import json
import unittest
import subprocess
from unittest.mock import patch
import restore_calibrated_office_workers as boot

G = boot.GIB


def fixture():
    sizes = [4, 4, 8, 8, 32, 8]
    entries = [dict(name='teamaibox-worker-worker-'+str(i), id=str(i)*64, image='sha256:'+'a'*64,
                    configurationSha256='b'*64, memoryLimitBytes=max(size, 12)*G) for i, size in enumerate(sizes)]
    base = dict(schemaVersion=2, containers=entries)
    raw = json.dumps(base).encode()
    value = dict(schemaVersion=1, nodeId='10000000-0000-4000-8000-000000000001',
                 baseManifestSha256=boot.digest(raw), independentMediaContainerId='f'*64,
                 coreMemoryBudget=dict(measuredPeakBytes=19080568832, reserveBytes=int(21.5*G),
                     growthPermille=1200, evidenceDigest='d'*64),
                 models=[dict(workerId='worker-'+str(i), containerId=e['id'], declaredResidentBytes=size*G)
                         for i, (e, size) in enumerate(zip(entries, sizes))])
    snapshot = dict(totalBytes=121*G, availableBytes=90*G, swapUsedBytes=0, fullAverage10=0.0,
                    otherBytes=16*G, unrealizedOtherBytes=8*G, corePeakBytes=17*G, oomKilled=False)
    return value, base, raw, snapshot


class FakeAdapter:
    def __init__(self, entries, snapshot, running=(), fail=None, rollback_fail=None):
        self.initial = set(running)
        self.running = set(running)
        self.entries = entries
        self.memory = snapshot
        self.fail, self.rollback_fail = fail, rollback_fail
        self.calls = []

    def inspect(self, entry):
        return dict(running=entry['id'] in self.running, healthy=entry['id'] in self.running,
                    oomKilled=False, startedAt='2026-10-08T00:00:00Z')

    def snapshot(self, value):
        return copy.deepcopy(self.memory)

    def start(self, entry):
        self.calls.append(('start', entry['id']))
        self.running.add(entry['id'])
        if entry['id'] == self.fail:
            raise RuntimeError('fixture_stage_failure')

    def stop(self, entry):
        self.calls.append(('stop', entry['id']))
        if entry['id'] == self.rollback_fail:
            raise RuntimeError('fixture_stop_failure')
        self.running.discard(entry['id'])

    monotonic = staticmethod(lambda: 0)
    sleep = staticmethod(lambda seconds: None)
    wait_ready = staticmethod(lambda check_only: None)


class BootTests(unittest.TestCase):
    def test_database_target_comes_from_this_installation(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'local_database_container_required'):
                boot.database_container()
        for invalid in ('', '--privileged', 'ssh://remote', 'db; command', 'db\nother'):
            with patch.dict('os.environ', {'TEAMAIBOX_POSTGRES_CONTAINER': invalid}):
                with self.assertRaisesRegex(RuntimeError, 'local_database_container_required'):
                    boot.database_container()
        with patch.dict('os.environ', {'TEAMAIBOX_POSTGRES_CONTAINER': 'office-postgres-1'}):
            self.assertEqual(boot.database_container(), 'office-postgres-1')

    def test_boot_cannot_use_another_appliance_configuration(self):
        value, _, _, _ = fixture()
        with patch.dict('os.environ', {'PLATFORM_APPLIANCE_NODE_ID': value['nodeId']}):
            boot.validate_appliance_binding(value)
        for node in ('', '11111111-1111-4111-8111-111111111111'):
            with patch.dict('os.environ', {'PLATFORM_APPLIANCE_NODE_ID': node}):
                with self.assertRaisesRegex(RuntimeError, 'boot_appliance_identity_mismatch'):
                    boot.validate_appliance_binding(value)

    def test_boot_does_not_read_resource_ledgers(self):
        import inspect
        import restore_calibrated_office_workers_v3 as casting
        for source in (inspect.getsource(boot.HostAdapter.snapshot),inspect.getsource(casting.CastingAdapter.raw_snapshot)):
            self.assertNotIn('resource_reservations',source)
        self.assertFalse(hasattr(casting,'reservation_query'))

    def test_boot_unit_loads_installation_configuration(self):
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        unit = (root / 'deploy/host/teamaibox-existing-office-workers.service').read_text()
        self.assertIn('EnvironmentFile=/etc/teamaibox/office-boot.env', unit)
        self.assertIn('restore_calibrated_office_workers_v3.py', unit)
        self.assertIn('--manifest ${TEAMAIBOX_OFFICE_BOOT_MANIFEST_FILE}', unit)
        self.assertIn('After=docker.service teamaibox-existing-business-volumes.service', unit)

    def test_database_recovery_is_awaited_before_model_start(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s)
        def wait(check_only):
            self.assertFalse(check_only)
            self.assertEqual(a.calls, [])
            a.calls.append(('database-ready', None))
        a.wait_ready = wait
        boot.restore(v, b['containers'], a)
        self.assertEqual(a.calls[0], ('database-ready', None))

    def test_database_wait_recovers_from_not_ready_and_probe_timeout(self):
        ticks, sleeps, calls = [0], [], [0]
        def probe():
            calls[0] += 1
            if calls[0] == 1: raise subprocess.TimeoutExpired('fixture', 5)
            return calls[0] == 3
        def sleep(seconds):
            sleeps.append(seconds); ticks[0] += seconds
        boot.wait_for_database(probe, lambda: ticks[0], sleep)
        self.assertEqual(sleeps, [2, 2])

    def test_database_wait_is_bounded_and_check_does_not_wait(self):
        ticks, sleeps = [0], []
        def sleep(seconds): sleeps.append(seconds); ticks[0] += seconds
        with self.assertRaisesRegex(RuntimeError, 'ready_timeout'):
            boot.wait_for_database(lambda: False, lambda: ticks[0], sleep, timeout=3)
        self.assertEqual(sleeps, [2, 1])
        sleeps.clear()
        with self.assertRaisesRegex(RuntimeError, 'not_ready'):
            boot.wait_for_database(lambda: False, lambda: ticks[0], sleep, check_only=True)
        self.assertEqual(sleeps, [])

    def test_database_failure_does_not_start_or_stop_any_model(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s)
        def wait(check_only): raise RuntimeError('boot_database_ready_timeout')
        a.wait_ready = wait
        with self.assertRaises(RuntimeError) as error: boot.restore(v, b['containers'], a)
        r = json.loads(str(error.exception))
        self.assertTrue(r['cleanupComplete'])
        self.assertEqual(r['startedIds'], [])
        self.assertEqual(a.calls, [])

    def test_exact_measured_configuration_and_order(self):
        v, b, raw, _ = fixture()
        self.assertEqual(boot.validate_configuration(v, b, raw), b['containers'])
        for mutate in ('digest', 'order', 'size', 'extra'):
            bad = copy.deepcopy(v)
            if mutate == 'digest': bad['baseManifestSha256'] = '0'*64
            if mutate == 'order': bad['models'].reverse()
            if mutate == 'size': bad['models'][0]['declaredResidentBytes'] = 0
            if mutate == 'extra': bad['extra'] = True
            with self.assertRaises(RuntimeError): boot.validate_configuration(bad, b, raw)





    def test_retained_swap_does_not_block_a_host_with_available_memory(self):
        v, _, _, s = fixture()
        self.assertEqual(boot.observe(v, {**s, 'swapUsedBytes': 256 * 1024**2}, set()), boot.observe(v, s, set()))

    def test_pressure_oom_and_new_core_growth_reject(self):
        v, _, _, s = fixture()
        for patch in [dict(swapUsedBytes=-1), dict(fullAverage10=.1), dict(fullAverage10=float('nan')),
                      dict(oomKilled=True), dict(availableBytes=-1)]:
            with self.assertRaises(RuntimeError): boot.observe(v, {**s, **patch}, set())

    def test_all_cold_members_start_in_existing_dependency_order(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s)
        r = boot.restore(v, b['containers'], a)
        self.assertEqual(r['count'], 6)
        self.assertEqual(a.calls, [('start', e['id']) for e in b['containers']])

    def test_check_is_read_only_and_preserves_every_start_time(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s, [e['id'] for e in b['containers']])
        r = boot.restore(v, b['containers'], a, True)
        self.assertEqual(a.calls, [])
        self.assertEqual(r['startedIds'], [])
        self.assertTrue(r['checkOnly'])

    def test_check_never_starts_missing_model(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s)
        with self.assertRaisesRegex(RuntimeError, 'not_running'): boot.restore(v, b['containers'], a, True)
        self.assertEqual(a.calls, [])

    def test_inflight_stage_is_not_double_counted_against_available_memory(self):
        v, b, _, s = fixture(); a = FakeAdapter(b['containers'], s)
        original_start = a.start
        def start(entry):
            original_start(entry)
            s['availableBytes'] -= next(p['declaredResidentBytes'] for p in v['models'] if p['containerId']==entry['id'])
        a.start = start
        self.assertEqual(boot.restore(v, b['containers'], a)['status'], 'passed')
        self.assertEqual(s['availableBytes'], 26*G)

    def test_failure_rolls_back_only_owned_starts_in_reverse_order(self):
        v, b, _, s = fixture(); e = b['containers']
        a = FakeAdapter(e, s, running=[e[0]['id']], fail=e[3]['id'])
        with self.assertRaises(RuntimeError) as error: boot.restore(v, e, a)
        result = json.loads(str(error.exception))
        self.assertTrue(result['cleanupComplete'])
        self.assertEqual(a.running, {e[0]['id']})
        self.assertEqual([cid for op, cid in a.calls if op=='stop'], [e[3]['id'], e[2]['id'], e[1]['id']])

    def test_failed_rollback_is_explicitly_incomplete(self):
        v, b, _, s = fixture(); e = b['containers']
        a = FakeAdapter(e, s, fail=e[2]['id'], rollback_fail=e[1]['id'])
        with self.assertRaises(RuntimeError) as error: boot.restore(v, e, a)
        self.assertEqual(json.loads(str(error.exception))['rollbackFailures'], [e[1]['id']])


if __name__ == '__main__': unittest.main()
