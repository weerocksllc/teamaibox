import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from open_source_release import baseline, exclusion, export, safe_source, scan
from open_source_sensitive import history, inspect
from open_source_inventory import inventory


class SourceReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='teamaibox-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'repo'
        self.root.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'synthetic@example.invalid')
        for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'docs/open-source/components.json']:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}' if name.endswith('.json') else 'Synthetic test notice\n')
        self.git('add', '.'); self.git('commit', '-qm', 'synthetic base')
        self.policy = {'excludePrefixes': {'vendor/': 'restricted', 'evidence/': 'private'}, 'excludeSuffixes': ['.png'], 'untrackedFiles': []}

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL)

    def scanner(self):
        path = os.environ.get('GITLEAKS')
        if not path:
            self.skipTest('set GITLEAKS to the verified local binary for scanner integration')
        return Path(path).resolve()

    def test_rejects_traversal_and_symlink(self):
        for path in ['../outside', '/outside', '.git/config']:
            with self.assertRaises(ValueError): safe_source(self.root, path)
        (self.root / 'escape').symlink_to(self.root.parent)
        with self.assertRaises(ValueError): safe_source(self.root, 'escape/data')

    def test_unknown_inputs_and_restricted_material_stay_private(self):
        (self.root / 'unreviewed.txt').write_text('private fixture')
        (self.root / 'vendor').mkdir(); (self.root / 'vendor/sdk.so').write_bytes(b'fixture')
        (self.root / 'opaque.bin').write_bytes(b'\0private-binary-fixture')
        self.git('add', 'opaque.bin')
        self.git('add', 'vendor'); self.git('commit', '-qm', 'synthetic restricted asset')
        path = self.root.parent / 'policy.json'; path.write_text(json.dumps(self.policy))
        before = baseline(self.root)['refs']
        output = self.root.parent / 'candidate'
        export(self.root, output, path, self.scanner())
        self.assertFalse((output / '.git').exists())
        self.assertFalse((output / 'vendor').exists())
        self.assertFalse((output / 'unreviewed.txt').exists())
        self.assertFalse((output / 'opaque.bin').exists())
        self.assertEqual(before, baseline(self.root)['refs'])
        with self.assertRaises(ValueError): export(self.root, output, path, self.scanner())

    def test_historical_secret_is_detected_after_deletion_and_redacted(self):
        # Generated synthetic token, never a real credential or sent to a provider.
        secret = 'ghp_' + 'Ab7Cd9Ef2Gh4Ij6Kl8Mn0Op3Qr5St7Uv9Wx1Yz2A'
        (self.root / 'old.env').write_text('GITHUB_TOKEN="' + secret + '"\n')
        self.git('add', '.'); self.git('commit', '-qm', 'synthetic secret fixture')
        self.git('rm', '-q', 'old.env'); self.git('commit', '-qm', 'remove synthetic fixture')
        out = self.root.parent / 'scan'
        value = scan(self.root, self.scanner(), out)
        self.assertGreater(value['scopes']['history']['findings'], 0)
        self.assertEqual(value['scopes']['worktree']['findings'], 0)
        for report in out.glob('*.json'): self.assertNotIn(secret, report.read_text())
        self.assertTrue(any(row['path'] == 'old.env' for row in history(self.root)['findings']))

    def test_commit_messages_defaults_and_binary_blind_spots(self):
        self.git('commit', '--allow-empty', '-qm', 'synthetic password="test-only-commit-literal"')
        self.assertTrue(any(row['path'] == '<commit>' for row in history(self.root)['findings']))
        found, _ = inspect(b'password="admin"', 'setup.py')
        self.assertEqual(found[0]['classification'], 'default-or-placeholder-review-context')
        self.assertNotIn('admin', json.dumps(found))
        found, skipped = inspect(b'\0fake-image', 'screen.png')
        self.assertFalse(found); self.assertEqual(skipped['reason'], 'binary-not-text-scanned')

    def test_exact_retired_paths_cannot_return_through_export(self):
        policy = {**self.policy, 'excludePaths': ['tools/synthetic_retired_recorder.py']}
        self.assertEqual(exclusion('tools/synthetic_retired_recorder.py', policy),
                         'retired-private-environment-tool-or-record')
        self.assertIsNone(exclusion('tools/maintained_installer.py', policy))
        root = Path(__file__).resolve().parents[1]
        current = json.loads((root / 'docs/open-source/release-policy.json').read_text())
        for name in current.get('excludePaths', []):
            self.assertIsNotNone(exclusion(name, current))

    def test_website_is_excluded_even_when_declared_as_input(self):
        policy = {**self.policy, 'excludePrefixes': {'website/': 'private-website'},
                  'untrackedFiles': ['website/index.html']}
        self.assertEqual(exclusion('website/index.html', policy), 'private-website')

    def test_exact_version_license_metadata_survives_source_only_checkout(self):
        # The minimal parser expects the same section boundary as pnpm.
        (self.root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9\n\npackages:\n\n  synthetic@1.0.0:\n    resolution: {}\n')
        path = self.root / 'docs/open-source/dependencies.json'
        path.write_text(json.dumps({'dependencies': [{'ecosystem': 'npm', 'name': 'synthetic', 'version': '1.0.0',
             'license': 'Apache-2.0', 'evidence': 'synthetic exact-version fixture'}]}))
        result = inventory(self.root)
        self.assertEqual(result['dependencies'][0]['license'], 'Apache-2.0')
        (self.root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9\n\npackages:\n\n  synthetic@2.0.0:\n    resolution: {}\n')
        self.assertEqual(inventory(self.root)['dependencies'][0]['license'], 'UNKNOWN')

    def test_real_license_scope_preserves_exceptions_and_install_build_inputs(self):
        root = Path(__file__).resolve().parents[1]
        components = json.loads((root / 'docs/open-source/components.json').read_text())
        self.assertEqual(components['originalLicense'], 'MIT')
        self.assertFalse(components['binaryRedistributionApproved'])
        by_name = {c['name']: c for c in components['components']}
        self.assertEqual(by_name['UxPlay and receiver patches']['license'], 'GPL-3.0-only')
        self.assertEqual(by_name['PyMuPDF / MuPDF OCR dependency']['license'], 'AGPL-3.0-or-later OR commercial')
        for item in components['components']:
            if item.get('evidence'):
                self.assertTrue((root / item['evidence']).is_file(), item['name'])
        policy = json.loads((root / 'docs/open-source/release-policy.json').read_text())
        self.assertIsNotNone(exclusion('vendor/usb-key-sdk/SDK.so', policy))
        self.assertIsNotNone(exclusion('evidence/private.json', policy))
        self.assertIn('services/node-agent/cmd/factory-worker-spec/main.go', policy['untrackedFiles'])
        for name in subprocess.check_output(['git','-C',str(root),'ls-files','*package.json'],text=True).splitlines():
            file = root / name
            if not file.is_file():
                continue
            value = json.loads(file.read_text())
            if str(value.get('name', '')).startswith('@teamaibox/') or name == 'package.json':
                self.assertEqual(value['license'], 'MIT', name)
                self.assertTrue(value.get('private'), name)


if __name__ == '__main__':
    unittest.main()
