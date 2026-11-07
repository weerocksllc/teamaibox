"""Corresponding-source admission checks. No network, Docker or user data."""
import os
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import package_penpot_sources as sources
from offline_common import InstallError


class CorrespondingSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.tree = self.root / 'source'
        self.tree.mkdir()
        (self.tree / 'LICENSE').write_text('synthetic license\n')
        (self.tree / 'build.sh').write_text('exit 0\n')
        (self.tree / 'build.sh').chmod(0o755)

    def test_archive_is_reproducible_without_host_metadata(self):
        sources.write_archive(self.tree, self.root / 'a.tar.gz')
        os.utime(self.tree / 'LICENSE', (1000, 1000))
        sources.write_archive(self.tree, self.root / 'b.tar.gz')
        self.assertEqual((self.root / 'a.tar.gz').read_bytes(), (self.root / 'b.tar.gz').read_bytes())
        with tarfile.open(self.root / 'a.tar.gz') as bundle:
            for entry in bundle.getmembers():
                self.assertEqual((entry.uid, entry.gid, entry.mtime, entry.uname, entry.gname), (0, 0, 0, '', ''))
                self.assertTrue(entry.name.startswith('teamaibox-design-source/'))
            self.assertEqual(bundle.getmember('teamaibox-design-source/build.sh').mode, 0o755)

    def test_private_generated_directory_and_escaping_link_rejected(self):
        (self.tree / '.git').mkdir()
        with self.assertRaises(InstallError):
            sources.inventory(self.tree)
        (self.tree / '.git').rmdir()
        (self.tree / 'escape').symlink_to(self.root)
        with self.assertRaises(InstallError):
            sources.inventory(self.tree)

    def test_safe_source_link_and_changes_preserved(self):
        before = sources.inventory(self.tree)
        (self.tree / 'license-copy').symlink_to('LICENSE')
        (self.tree / 'LICENSE').write_text('modified notice\n')
        changes = sources.changes(before, sources.inventory(self.tree))
        self.assertEqual(set(changes), {'license-copy', 'LICENSE'})
        self.assertIsNone(changes['license-copy']['before'])
        self.assertEqual(changes['license-copy']['after'], {'kind': 'link', 'target': 'LICENSE'})

    def test_existing_output_is_preserved_before_preparation(self):
        output = self.root / 'retain.tar.gz'
        output.write_bytes(b'retain')
        with patch.object(sources, 'prepare') as prepare, self.assertRaises(InstallError):
            sources.package(self.root / 'cache', output, self.tree)
        prepare.assert_not_called()
        self.assertEqual(output.read_bytes(), b'retain')

    def test_reviewed_build_input_set_is_unique_and_complete(self):
        self.assertEqual(len(sources.BUILD_FILES), len(set(sources.BUILD_FILES)))
        for name in sources.BUILD_FILES:
            self.assertTrue((sources.ROOT / name).is_file(), name)
            self.assertFalse(any(p in name.split('/') for p in ['website', 'openspec', '.git']))
        for name in sources.PATCH_INPUTS:
            self.assertIn('install/' + name, sources.BUILD_FILES)

    def source_fixture(self):
        for name in ['penpot/LICENSE', 'opencode/LICENSE', 'integration/LICENSES/MPL-2.0.txt',
                     'integration/install/PENPOT-DEVELOPMENT.md']:
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic covered source\n')
        records = sources.inventory(self.tree)
        (self.tree / 'SOURCE-MANIFEST.json').write_text(json.dumps({
            'schema': 'teamaibox-design-corresponding-source-v1', 'files': records}))
        (self.tree / 'README.txt').write_text('Synthetic source instructions\n')
        return records

    def test_verifier_accepts_exact_source_and_rejects_changed_payload(self):
        records = self.source_fixture()
        sources.write_archive(self.tree, self.root / 'valid.tar.gz')
        self.assertEqual(sources.verify_archive(self.root / 'valid.tar.gz')['files'], records)
        (self.tree / 'penpot/LICENSE').write_text('tampered\n')
        sources.write_archive(self.tree, self.root / 'tampered.tar.gz')
        with self.assertRaisesRegex(InstallError, 'hash mismatch'):
            sources.verify_archive(self.root / 'tampered.tar.gz')

    def test_verifier_accepts_native_relative_directory_links(self):
        (self.tree / 'lib').mkdir()
        (self.tree / 'lib' / 'source.txt').write_text('native source')
        (self.tree / 'linked-lib').symlink_to('lib')
        self.source_fixture()
        sources.write_archive(self.tree, self.root / 'links.tar.gz')
        sources.verify_archive(self.root / 'links.tar.gz')

    def test_verifier_rejects_undeclared_file(self):
        self.source_fixture()
        (self.tree / 'unrelated.txt').write_text('must not be shipped')
        sources.write_archive(self.tree, self.root / 'extra.tar.gz')
        with self.assertRaisesRegex(InstallError, 'undeclared'):
            sources.verify_archive(self.root / 'extra.tar.gz')


if __name__ == '__main__':
    unittest.main()
