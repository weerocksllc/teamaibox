import copy
import unittest
from restore_appliance_frontdoor import recover
from restore_calibrated_office_workers_v2 import settled_snapshot
from test_calibrated_office_boot import fixture, G
from restore_calibrated_office_workers import gpu_allow_arguments


class FakeDocker:
    def __init__(self, running=()):
        self.config = {'retired': [{'name': 'old-web', 'id': 'a'*64}],
                       'ordered': [{'name': name, 'id': letter*64} for name, letter in
                                   [('network', 'b'), ('api', 'c'), ('gateway', 'd'), ('web', 'e')]]}
        self.rows = {r['id']: {'Name': '/'+r['name'], 'Id': r['id'],
                     'State': {'Running': r['name'] in running},
                     'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}}
                     for r in self.config['retired'] + self.config['ordered']}
        self.calls = []
        self.ticks = 0

    def inspect(self, row):
        value = self.rows[row['id']]
        if value['Name'] != '/'+row['name']: raise RuntimeError('changed')
        return copy.deepcopy(value)

    def run(self, *args):
        self.calls.append(args)
        value = self.rows[args[-1]]
        if args[0] == 'update': value['HostConfig']['RestartPolicy']['Name'] = 'no'
        if args[0] in ('start', 'stop'): value['State']['Running'] = args[0] == 'start'
        if args[0] == 'start' and args[-1] in ('c'*64, 'd'*64):
            assert self.rows['b'*64]['State']['Running']

    def monotonic(self): return self.ticks
    def sleep(self, seconds): self.ticks += seconds


class RecoveryTests(unittest.TestCase):
    def test_gpu_rules_keep_existing_device_permissions_and_are_exact(self):
        result = gpu_allow_arguments(['block-* m', '/dev/char/1:3 rwm'], ['/dev/nvidia0', '/dev/nvidiactl'])
        self.assertEqual(result, ['DeviceAllow=', 'DeviceAllow=block-* m', 'DeviceAllow=/dev/char/1:3 rwm',
                                 'DeviceAllow=/dev/nvidia0 rwm', 'DeviceAllow=/dev/nvidiactl rwm'])

    def test_retired_web_stops_before_current_web_and_dependencies_start_first(self):
        d = FakeDocker(['old-web'])
        result = recover(d.config, d)
        self.assertEqual(result['started'], ['network', 'api', 'gateway', 'web'])
        self.assertEqual([x[0] for x in d.calls], ['update', 'stop', 'start', 'start', 'start', 'start'])
        self.assertFalse(d.rows['a'*64]['State']['Running'])
        d.calls.clear()
        self.assertEqual(recover(d.config, d)['started'], [])
        self.assertEqual(d.calls, [])

    def test_identity_drift_cannot_stop_any_container(self):
        d = FakeDocker(['old-web']); d.rows['e'*64]['Name'] = '/other'
        with self.assertRaises(RuntimeError): recover(d.config, d)
        self.assertEqual(d.calls, [])

    def test_unhealthy_dependency_blocks_downstream_without_removal(self):
        d = FakeDocker(['network']); d.rows['b'*64]['State']['Health'] = {'Status': 'unhealthy'}
        with self.assertRaisesRegex(RuntimeError, 'readiness_timeout'): recover(d.config, d, timeout=3)
        self.assertFalse(any(c[0] == 'start' for c in d.calls))
        self.assertFalse(any(c[0] in ('rm', 'restart') for c in d.calls))

    def test_boot_waits_for_stale_reservations_without_lowering_budgets(self):
        value, _, _, good = fixture()
        stale = {**good, 'otherBytes': 28*G, 'unrealizedOtherBytes': 28*G}
        samples, ticks = iter([stale, good]), [0]
        result, observations = settled_snapshot(value, lambda _: next(samples), lambda: ticks[0],
            lambda seconds: ticks.__setitem__(0, ticks[0]+seconds), wait_for_capacity=True)
        self.assertEqual(len(observations), 2)
        self.assertEqual(result, good)
        self.assertEqual(value['coreMemoryBudget']['reserveBytes'], 21.5*G)

    def test_persistent_capacity_shortage_is_bounded_and_check_does_not_wait(self):
        value, _, _, good = fixture()
        stale = {**good, 'otherBytes': 28*G}
        for check in (False, True):
            ticks = [0]
            with self.assertRaisesRegex(RuntimeError, 'capacity_insufficient'):
                settled_snapshot(value, lambda _: stale, lambda: ticks[0],
                    lambda s: ticks.__setitem__(0, ticks[0]+s), check_only=check, timeout=3, wait_for_capacity=True)
            self.assertEqual(ticks[0], 0 if check else 3)

    def test_oom_is_never_waited_away(self):
        value, _, _, good = fixture()
        for patch in ({'oomKilled': True},):
            with self.assertRaisesRegex(RuntimeError, 'boot_memory_pressure'):
                settled_snapshot(value, lambda _: {**good, **patch}, lambda: 0,
                    lambda _: self.fail('must not wait'), wait_for_capacity=True)


if __name__ == '__main__': unittest.main()
