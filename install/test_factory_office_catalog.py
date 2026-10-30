import copy
import json
from pathlib import Path
import unittest
import uuid

from factory_office import bind, definitions, PROFILES
from factory_office_catalog import documents, fingerprint, statements
from offline_common import InstallError

REPO = Path(__file__).resolve().parents[1]


def fixture():
    identity = str(uuid.uuid4())
    runtime = bind(definitions(REPO), identity,
        {r + '-worker': 'sha256:' + 'a' * 64 for r in PROFILES},
        {r + '-model': '/new/assets/' + r for r in PROFILES} | {'drawing-runtime': '/new/assets/runtime'})
    release = dict(releaseId='installer-test', assets=[dict(role=r + '-model', files=[
        dict(path='config.json', size=10, sha256='b' * 64),
        dict(path='LICENSE', size=12, sha256='c' * 64)]) for r in PROFILES])
    return runtime, release, identity


class CatalogTests(unittest.TestCase):
    def test_go_normalizer_may_omit_empty_cpu_device_list(self):
        runtime, release, identity = fixture()
        runtime['workers']['asr'].pop('devices')
        doc = documents(runtime, release, identity, '2026-10-24T00:00:00.000Z')['asr']
        self.assertEqual(doc['resourceEnvelope']['acceleratorUnits'], 0)
        self.assertEqual(doc['compatibility']['hardware']['acceleratorFamilies'], [])

    def test_registration_is_repeatable_and_contains_no_development_identity(self):
        runtime, release, identity = fixture()
        docs = documents(runtime, release, identity, '2026-10-24T00:00:00.000Z')
        self.assertEqual(docs, documents(runtime, release, identity, '2026-10-24T00:00:00.000Z'))
        serialized = json.dumps(docs)
        for forbidden in ('192.168.', '/home/', 'fabricSsh', 'sourceImageTag', 'certifiedImageId'):
            self.assertNotIn(forbidden, serialized)
        for doc in docs.values():
            self.assertEqual(doc['validationEvidence'], [])
            self.assertEqual(doc['certification']['state'], 'validating')
            self.assertEqual(doc['source']['provenance']['evidenceRef'], None)
        self.assertEqual(docs['ocr']['source']['license']['reviewStatus'], 'pending')

    def test_document_matches_required_contract_fields_recursively(self):
        runtime, release, identity = fixture()
        schema = json.loads((REPO / 'packages/contracts/compute/model-profile.v1.schema.json').read_text())
        def walk(value, rule):
            if '$ref' in rule:
                rule = schema['$defs'][rule['$ref'].split('/')[-1]]
            if isinstance(value, dict) and 'properties' in rule:
                self.assertTrue(set(rule.get('required', [])) <= value.keys())
                if rule.get('additionalProperties') is False:
                    self.assertTrue(value.keys() <= rule['properties'].keys())
                for key, child in value.items():
                    walk(child, rule['properties'].get(key, {}))
            if isinstance(value, list) and 'items' in rule:
                for child in value:
                    walk(child, rule['items'])
            if 'enum' in rule:
                self.assertIn(value, rule['enum'])
        for doc in documents(runtime, release, identity, '2026-10-24T00:00:00.000Z').values():
            walk(doc, schema)
            if doc['precision'] == 'bf16':
                self.assertIsNone(doc['quantizationRecipe'])
            else:
                walk(doc['quantizationRecipe'], schema['$defs']['quantizationRecipe'])

    def test_missing_license_is_rejected_not_fabricated(self):
        runtime, release, identity = fixture()
        release['assets'][0]['files'] = release['assets'][0]['files'][:1]
        with self.assertRaises(InstallError):
            documents(runtime, release, identity, '2026-10-24T00:00:00.000Z')

    def test_actual_artifact_changes_identity_and_sql_does_not_overwrite(self):
        runtime, release, identity = fixture()
        docs = documents(runtime, release, identity, '2026-10-24T00:00:00.000Z')
        changed = copy.deepcopy(release)
        changed['assets'][0]['files'][0]['sha256'] = 'd' * 64
        after = documents(runtime, changed, identity, '2026-10-24T00:00:00.000Z')
        self.assertNotEqual(fingerprint(docs['assistant']), fingerprint(after['assistant']))
        sql = statements(runtime, docs)
        self.assertNotIn('DO UPDATE', sql)
        self.assertNotIn('DELETE ', sql)
        self.assertIn("'recovering'", sql)
        check = statements(runtime, docs, check=True)
        self.assertTrue(check.startswith('BEGIN READ ONLY'))
        self.assertNotIn('INSERT INTO', check)


if __name__ == '__main__':
    unittest.main()
