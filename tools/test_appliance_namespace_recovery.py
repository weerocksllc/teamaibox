import copy
import unittest

from restore_appliance_namespace import SIDECARS, recover


class FakeDocker:
    def __init__(self):
        self.record = {'services': {r: {} for r in ('platform-api', 'postgres', *SIDECARS)}}
        self.rows = {role: {'Id': role, 'Name': '/' + role,
                           'HostConfig': {'NetworkMode': 'container:platform-api'},
                           'State': {'Running': True, 'StartedAt': 'initial', 'Health': {'Status': 'healthy'}},
                           'namespace': 'current'} for role in self.record['services']}
        self.calls, self.ticks, self.control = [], 0, True
        self.changed = set()
        self.on_restart = lambda role: None

    def resolve(self, record, role):
        if role in self.changed:
            raise ValueError('identity_changed')
        return copy.deepcopy(self.rows[role])

    def namespace(self, row):
        if not row['State']['Running'] or row['State'].get('Restarting'):
            raise RuntimeError('namespace_service_not_running')
        return row['namespace']

    def restart(self, row):
        role = row['Id']; self.calls.append(role)
        self.rows[role]['namespace'] = 'current'
        self.on_restart(role)

    def monotonic(self): return self.ticks
    def sleep(self, seconds): self.ticks += seconds
    def control_ready(self, record, gateway): return self.control


class RecoveryTests(unittest.TestCase):
    def test_correct_docker_binding_but_stale_live_namespace_is_repaired(self):
        d = FakeDocker()
        for role in SIDECARS: d.rows[role]['namespace'] = 'old'
        result = recover(d.record, d)
        self.assertEqual(result['restarted'], list(SIDECARS))
        self.assertNotIn('platform-api', d.calls)
        self.assertNotIn('postgres', d.calls)
        d.calls.clear()
        self.assertEqual(recover(d.record, d)['restarted'], [])
        self.assertEqual(d.calls, [])

    def test_only_mismatching_sidecar_is_restarted(self):
        d = FakeDocker(); d.rows['node-agent']['namespace'] = 'old'
        recover(d.record, d)
        self.assertEqual(d.calls, ['node-agent'])

    def test_check_detects_failure_without_writes(self):
        d = FakeDocker(); d.rows['node-agent']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'namespace_disconnected'):
            recover(d.record, d, check=True)
        self.assertEqual(d.calls, [])

    def test_live_control_path_failure_is_not_reported_as_healthy(self):
        d = FakeDocker(); d.control = False
        with self.assertRaisesRegex(RuntimeError, 'control_path_not_ready'):
            recover(d.record, d)
        self.assertEqual(d.calls, [])

    def test_real_heartbeat_is_required_after_repair(self):
        d = FakeDocker(); d.control = False; d.rows['node-agent']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'control_path_not_ready'):
            recover(d.record, d, timeout=4)
        self.assertEqual(d.calls, ['node-agent'])
        # Subsequent invocations must not churn a correctly connected service.
        d.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'control_path_not_ready'):
            recover(d.record, d)
        self.assertEqual(d.calls, [])

    def test_all_identities_are_checked_before_mutation(self):
        for role in ('platform-api', 'postgres', *SIDECARS):
            d = FakeDocker(); d.rows['appliance-gateway']['namespace'] = 'old'; d.changed.add(role)
            with self.assertRaises(ValueError): recover(d.record, d)
            self.assertEqual(d.calls, [])

    def test_replaced_parent_binding_requires_upgrade_transaction(self):
        d = FakeDocker(); d.rows['node-agent']['HostConfig']['NetworkMode'] = 'container:retired-api'
        d.rows['appliance-gateway']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'binding_changed'): recover(d.record, d)
        self.assertEqual(d.calls, [])

    def test_intentionally_stopped_sidecar_is_preserved(self):
        d = FakeDocker(); d.rows['node-agent']['State']['Running'] = False
        d.rows['appliance-gateway']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'not_running'): recover(d.record, d)
        self.assertEqual(d.calls, [])

    def test_owner_must_be_healthy_before_repair(self):
        d = FakeDocker(); d.rows['platform-api']['State']['Health']['Status'] = 'starting'
        d.rows['node-agent']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'owner_not_ready'): recover(d.record, d)
        self.assertEqual(d.calls, [])

    def test_parent_restarting_during_recovery_stops_further_mutations(self):
        d = FakeDocker()
        for role in SIDECARS: d.rows[role]['namespace'] = 'old'
        d.on_restart = lambda role: d.rows['platform-api']['State'].update(StartedAt='changed')
        with self.assertRaisesRegex(RuntimeError, 'owner_changed'): recover(d.record, d)
        self.assertEqual(d.calls, ['appliance-gateway'])

    def test_independent_namespaces_and_unregistered_guests_are_not_touched(self):
        d = FakeDocker()
        d.rows['guest'] = copy.deepcopy(d.rows['node-agent']); d.rows['guest']['namespace'] = 'old'
        d.rows['desktop-gateway']['HostConfig']['NetworkMode'] = 'bridge'
        d.rows['desktop-gateway']['namespace'] = 'independent'
        self.assertNotIn('desktop-gateway', recover(d.record, d)['checked'])
        self.assertEqual(d.calls, [])

    def test_failed_rejoin_never_reports_success(self):
        d = FakeDocker(); d.rows['node-agent']['namespace'] = 'old'
        d.on_restart = lambda role: d.rows[role].update(namespace='still-old')
        with self.assertRaisesRegex(RuntimeError, 'rejoin_failed'): recover(d.record, d)

    def test_incomplete_control_cohort_rejected_before_restart(self):
        d = FakeDocker(); del d.record['services']['node-agent']
        d.rows['appliance-gateway']['namespace'] = 'old'
        with self.assertRaisesRegex(RuntimeError, 'cohort_incomplete'): recover(d.record, d)
        self.assertEqual(d.calls, [])


if __name__ == '__main__': unittest.main()
