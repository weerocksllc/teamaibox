import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).parents[1]))
from phone_pressure_single_fixture import action, GIB, FLOOR, TARGET, MAX_BYTES


class SinglePressureFixtureTests(unittest.TestCase):
    def setUp(self):
        self.initial = {'available': 25*GIB, 'phones': {
            'test': {'phase': 'running', 'protectionReason': None, 'startedAtUnixMs': 2},
            'original': {'phase': 'running', 'protectionReason': None, 'startedAtUnixMs': 1}}}

    def evaluate(self, current, allocated=0, elapsed=0):
        return action(current, self.initial, 'test', 'original', allocated, elapsed)

    def test_only_newest_target_protection_passes(self):
        value = copy.deepcopy(self.initial)
        value['phones']['test']['protectionReason'] = 'phone_capacity_exceeded'
        self.assertEqual(self.evaluate(value), 'target_protected')
        value['phones']['original']['phase'] = 'stopping'
        self.assertEqual(self.evaluate(value), 'original_phone_changed')

    def test_bounds_and_state_abort(self):
        value = copy.deepcopy(self.initial)
        self.assertEqual(self.evaluate(value), 'allocate')
        self.assertEqual(self.evaluate(value, MAX_BYTES), 'allocation_cap')
        self.assertEqual(self.evaluate(value, elapsed=240), 'deadline')
        value['available'] = TARGET
        self.assertEqual(self.evaluate(value), 'hold')
        value['available'] = FLOOR-1
        self.assertEqual(self.evaluate(value), 'safety_floor')
        value['phones']['test']['phase'] = 'stopped'
        self.assertEqual(self.evaluate(value), 'target_unexpected_state')


if __name__ == '__main__':
    unittest.main()
