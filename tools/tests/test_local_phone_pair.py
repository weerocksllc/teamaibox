import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pair', Path(__file__).parents[1] / 'check_local_phone_pair.py')
pair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pair)


class PairProbeTests(unittest.TestCase):
    def test_requires_matching_cidr_and_increase(self):
        rule = '-A PHONE_PUBLIC -d 192.168.0.0/16 -j REJECT --reject-with icmp-port-unreachable'
        self.assertEqual(pair.rejection_deltas({rule: 2}, {rule: 4}, '192.168.0.0/16'), {rule: 2})
        self.assertEqual(pair.rejection_deltas({rule: 2}, {rule: 2}, '192.168.0.0/16'), {})
        self.assertEqual(pair.rejection_deltas({rule: 2}, {rule: 4}, '172.16.0.0/12'), {})


if __name__ == '__main__':
    unittest.main()
