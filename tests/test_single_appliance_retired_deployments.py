"""Old lab deployment chains must not re-enter current executable tooling."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
RECORD = ROOT / 'docs/validation/single-appliance-deployment-retirement-20261017.json'


class RetiredDeploymentTests(unittest.TestCase):
    def test_removed_entrypoints_are_absent(self):
        record = json.loads(RECORD.read_text())
        self.assertFalse(record['historicalEvidenceModified'])
        self.assertFalse(record['runtimeMutationsPerformed'])
        for entry in record['entries']:
            with self.subTest(path=entry['path']):
                self.assertFalse((ROOT / entry['path']).exists())

    def test_no_fixed_peer_config_is_packaged_by_production(self):
        for folder in ('deploy/images', 'deploy/appliance'):
            for path in (ROOT / folder).glob('*.Dockerfile'):
                for line in path.read_text().splitlines():
                    if line.startswith('COPY '):
                        with self.subTest(path=path.name, copy=line):
                            self.assertNotRegex(line, r'fine-tuning-runtime\.spark23|backup-runtime\.spark23|maintenance-runtime\.dual')


if __name__ == '__main__':
    unittest.main()
