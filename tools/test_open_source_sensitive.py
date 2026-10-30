"""Only synthetic inputs; does not access devices, accounts or remote services."""
import json
from pathlib import Path
import unittest
import tempfile

from open_source_release import exclusion
from open_source_sensitive import inspect, load_denied_markers


class SensitiveMetadataTest(unittest.TestCase):
    def test_embedded_device_metadata_is_detected_without_disclosing_values(self):
        phone = 'teamaibox-phone-' + '11111111-1111-4111-8111-111111111111'
        gsf_hash = 'a' * 64
        source = f"C='{phone}'\nassert state['gsfIdSha256'] != '{gsf_hash}'\n"
        findings, skipped = inspect(source.encode(), 'synthetic-history.py')
        self.assertIsNone(skipped)
        self.assertEqual({row['rule'] for row in findings},
                         {'embedded-phone-identity', 'embedded-gsf-hash',
                          'embedded-instance-identity', 'uuid-literal'})
        self.assertEqual(sorted(row['line'] for row in findings), [1, 1, 1, 2])
        report = json.dumps(findings)
        self.assertNotIn(phone, report)
        self.assertNotIn(gsf_hash, report)

    def test_runtime_derived_identifiers_are_not_misreported_as_embedded(self):
        source = "state['gsfIdSha256'] = hashlib.sha256(gsf.encode()).hexdigest()\n"
        findings, skipped = inspect(source.encode(), 'synthetic-runtime.py')
        self.assertEqual(findings, [])
        self.assertIsNone(skipped)

    def test_retired_device_evidence_scripts_are_excluded_from_future_exports(self):
        policy_path = Path(__file__).resolve().parents[1] / 'docs/open-source/release-policy.json'
        policy = json.loads(policy_path.read_text())
        for name in ('cache_recovery', 'new_phone_recovery', 'new_phone_store'):
            self.assertEqual(exclusion(f'tools/record_google_{name}.py', policy),
                             'historical-device-specific-material')

    def test_fixed_smoke_credentials_are_reviewed_even_in_test_named_paths(self):
        source = b'const TEST_LOGIN = "synthetic-review-user";\nconst TEST_PASSWORD = "synthetic-review-phrase";\n'
        found, _ = inspect(source, 'tools/run_synthetic_browser_smoke.mjs')
        self.assertEqual({row['rule'] for row in found}, {'login-literal', 'credential-literal'})
        # Test naming is never an automatic credential exception.
        self.assertTrue(any(row['classification'] == 'review-required' for row in found))
        self.assertNotIn('synthetic-review-user', json.dumps(found))
        self.assertNotIn('synthetic-review-phrase', json.dumps(found))

    def test_private_denied_markers_are_external_and_redacted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'private-marker-list.json'
            marker = 'synthetic-' + 'historical-value'
            path.write_text(json.dumps([{'id': 'fixture-one', 'value': marker}]))
            rules = load_denied_markers(path)
            found, _ = inspect(('data=' + marker).encode(), 'fixture.txt', denied=rules)
            self.assertEqual(found[0]['rule'], 'known-private-marker:fixture-one')
            self.assertEqual(found[0]['classification'], 'confirmed-private-marker-must-not-publish')
            self.assertNotIn(marker, json.dumps(found))

    def test_invalid_marker_list_does_not_echo_its_values(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'invalid.json'
            marker = 'synthetic-' + 'private-text'
            path.write_text(json.dumps([{'id': marker + ' invalid', 'value': marker}]))
            with self.assertRaises(ValueError) as result:
                load_denied_markers(path)
            self.assertNotIn(marker, str(result.exception))

    def test_word_marker_does_not_match_an_unrelated_longer_name(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'markers.json'
            path.write_text(json.dumps([{'id': 'fixture-name', 'value': 'sample', 'word': True}]))
            rules = load_denied_markers(path)
            found, _ = inspect(b'samples sample-value sample', 'fixture.txt', denied=rules)
            self.assertEqual(len(found), 1)

    def test_documented_factory_default_stays_classified_not_silently_changed(self):
        found, _ = inspect(b'password="admin"', 'install/factory-fixture.py')
        self.assertEqual(found[0]['classification'], 'default-or-placeholder-review-context')


if __name__ == '__main__':
    unittest.main()
