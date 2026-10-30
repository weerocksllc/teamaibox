"""Publication-only regression check; no appliance or business tests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from open_source_release import exclusion, export


class WebsiteExclusionTests(unittest.TestCase):
    def test_tracked_and_allowlisted_website_files_are_not_exported(self):
        policy = json.loads((Path(__file__).resolve().parents[1] / 'docs/open-source/release-policy.json').read_text())
        names = ['website/index.html', 'website/article-template/header.html',
                 'website/site-config.json', 'website/articles/example.md']
        for name in names:
            self.assertEqual(exclusion(name, policy),
                             'private-marketing-website-not-in-public-product-source')
        scanner = os.environ.get('GITLEAKS')
        if not scanner:
            self.skipTest('Set GITLEAKS to the verified 8.30.1 binary for export integration')
        with tempfile.TemporaryDirectory(prefix='teamaibox-website-exclusion-') as temporary:
            root = Path(temporary).resolve() / 'source'
            root.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q')
            git('config', 'user.name', 'Synthetic Test')
            git('config', 'user.email', 'synthetic@example.invalid')
            for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'docs/open-source/components.json']:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('{}' if name.endswith('.json') else 'Synthetic license notice\n')
            git('add', '.')
            for name in names:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('Synthetic private website fixture\n')
            git('add', names[0])
            git('commit', '-qm', 'synthetic tracked website')
            policy['untrackedFiles'] = names[1:]
            policy_path = root.parent / 'policy.json'
            policy_path.write_text(json.dumps(policy))
            output = root.parent / 'public-source'
            export(root, output, policy_path, Path(scanner).resolve())
            self.assertFalse((output / 'website').exists())
            self.assertTrue((output / 'LICENSE').is_file())
            excluded = json.loads((root.parent / 'public-source-inventory.json').read_text())['exclusions']
            self.assertEqual({row['path'] for row in excluded}, set(names))
            self.assertTrue(all(row['reason'] == 'private-marketing-website-not-in-public-product-source'
                                for row in excluded))


if __name__ == '__main__':
    unittest.main()
