import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from appliance_delivery import replace, resume, rollback


class PenpotDeliverySafety(unittest.TestCase):
    def test_generic_replacement_never_opens_penpot_data(self):
        with patch('appliance_delivery.load') as load, patch('appliance_delivery.docker_api') as mutate:
            for role in ('penpot-backend', 'penpot-postgres'):
                with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'penpot_data_upgrade_required'):
                    replace('unused', role, 'unused', 'unused')
            load.assert_not_called()
            mutate.assert_not_called()

    def test_legacy_journals_are_refused_before_resume_or_rollback(self):
        with tempfile.TemporaryDirectory() as work, patch('appliance_delivery.load') as load, \
                patch('appliance_delivery.docker_api') as mutate:
            journal = Path(work) / 'synthetic.json'
            for role in ('penpot-backend', 'penpot-postgres'):
                for job in ({'role': role}, {'role': 'platform-api', 'namespaceGroup': True, 'members': {role: {}}}):
                    journal.write_text(json.dumps(job))
                    for action in (resume, rollback):
                        with self.subTest(role=role, action=action), self.assertRaisesRegex(ValueError, 'penpot_data_upgrade_required'):
                            action('unused', journal)
            load.assert_not_called()
            mutate.assert_not_called()

    def test_existing_stateless_replacement_is_not_blocked(self):
        with patch('appliance_delivery.load', return_value={}), \
                patch('appliance_delivery.resolve', return_value={'Image': 'same', 'Id': 'old'}), \
                patch('appliance_delivery.execute', return_value='[{"Architecture":"arm64","Os":"linux","Id":"same"}]'):
            self.assertEqual(replace('unused', 'platform-api', 'same', 'missing-synthetic-journal'),
                             {'status': 'unchanged', 'containerId': 'old'})


if __name__ == '__main__':
    unittest.main()
