import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from appliance_restart_policy import build_restart_policy


class ApplianceRestartPolicyTests(unittest.TestCase):
    def setUp(self):
        self.node = '00000000-0000-4000-8000-000000000101'
        self.platform = dict(containerName='api', imageId='sha256:' + 'a' * 64,
                             imageReference='sha256:' + 'a' * 64,
                             configurationDigest='sha256:' + 'b' * 64, requireHealthy=True)
        self.agent = {**self.platform, 'containerName': 'agent'}

    def test_order_independent_inputs_bind_generation_and_configuration(self):
        baseline = build_restart_policy(self.node, 12, self.platform, self.agent)
        reordered = dict(reversed(list(self.platform.items())))
        self.assertEqual(baseline, build_restart_policy(self.node, 12, reordered, self.agent))
        self.assertNotEqual(baseline['policyDigest'], build_restart_policy(self.node, 13, self.platform, self.agent)['policyDigest'])
        changed = {**self.agent, 'configurationDigest': 'sha256:' + 'c' * 64}
        self.assertNotEqual(baseline['policyDigest'], build_restart_policy(self.node, 12, self.platform, changed)['policyDigest'])

    def test_no_wildcard_target_or_disabled_health_check(self):
        for change in ({'containerName': '*'}, {'requireHealthy': False}, {'configurationDigest': 'latest'}, {'extra': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                build_restart_policy(self.node, 12, {**self.platform, **change}, self.agent)
        with self.assertRaises(ValueError):
            build_restart_policy(self.node, 12, self.platform, self.platform)

    def test_inputs_unchanged(self):
        before = copy.deepcopy(self.platform)
        build_restart_policy(self.node, 12, self.platform, self.agent)
        self.assertEqual(before, self.platform)


if __name__ == '__main__':
    unittest.main()
