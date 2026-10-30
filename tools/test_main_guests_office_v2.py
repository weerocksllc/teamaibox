import copy
import unittest
from appliance_resource_facts import normalize_guest_facts


class GuestMountIdentityTest(unittest.TestCase):
    def setUp(self):
        self.facts = dict(containers=[dict(id='exact', mounts=[
            dict(Destination='/guest', Source='/data/exact', RW=True, Type='bind'),
            dict(Destination='/control', Source='/control/exact', RW=True, Type='bind'),
        ])])

    def test_only_array_order_is_irrelevant(self):
        other = copy.deepcopy(self.facts)
        other['containers'][0]['mounts'].reverse()
        self.assertEqual(normalize_guest_facts(self.facts), normalize_guest_facts(other))
        self.assertEqual(self.facts['containers'][0]['mounts'][0]['Destination'], '/guest')

    def test_path_mode_and_container_changes_remain_visible(self):
        for field, value in [('Source', '/wrong'), ('RW', False), ('Type', 'volume')]:
            other = copy.deepcopy(self.facts)
            other['containers'][0]['mounts'][0][field] = value
            self.assertNotEqual(normalize_guest_facts(self.facts), normalize_guest_facts(other))
        other = copy.deepcopy(self.facts)
        other['containers'][0]['id'] = 'replacement'
        self.assertNotEqual(normalize_guest_facts(self.facts), normalize_guest_facts(other))

    def test_ambiguous_mounts_are_rejected(self):
        self.facts['containers'][0]['mounts'][1]['Destination'] = '/guest'
        with self.assertRaises(RuntimeError):
            normalize_guest_facts(self.facts)


if __name__ == '__main__':
    unittest.main()
