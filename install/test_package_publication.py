from pathlib import Path
import os
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from offline_common import InstallError
from package import portable_header, publish


class PublicationTests(unittest.TestCase):
    def paths(self, root):
        stage = root / 'stage'
        stage.mkdir()
        payload = stage / 'payload'
        payload.mkdir()
        (payload / 'file').write_bytes(b'new package')
        archive = stage / 'package.tar'
        archive.write_bytes(b'archive')
        return payload, archive, root / 'release', root / 'release.tar'

    def test_existing_release_and_checksum_are_preserved(self):
        for collision in ('directory', 'archive', 'checksum'):
            with self.subTest(collision=collision), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                payload, pending, final, archive = self.paths(root)
                target = final if collision == 'directory' else archive if collision == 'archive' else root / 'release.tar.sha256'
                target.write_bytes(b'previous release')
                with self.assertRaisesRegex(InstallError, 'preserved'):
                    publish(payload, pending, final, archive, 'a' * 64)
                self.assertEqual(target.read_bytes(), b'previous release')
                self.assertTrue(payload.exists())
                self.assertTrue(pending.exists())

    def test_failed_publication_does_not_leave_a_successful_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload, pending, final, archive = self.paths(root)
            original = os.rename
            def rename(source, destination):
                if destination == archive:
                    raise OSError('injected publication failure')
                original(source, destination)
            with patch('package.os.rename', side_effect=rename), self.assertRaisesRegex(OSError, 'injected'):
                publish(payload, pending, final, archive, 'a' * 64)
            self.assertFalse(final.exists())
            self.assertFalse(archive.exists())
            self.assertFalse((root / 'release.tar.sha256').exists())
            self.assertEqual((payload / 'file').read_bytes(), b'new package')

    def test_success_publishes_checksum_last(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload, pending, final, archive = self.paths(root)
            publish(payload, pending, final, archive, 'a' * 64)
            self.assertEqual((root / 'release.tar.sha256').read_text(), 'a' * 64 + '  release.tar\n')
            self.assertEqual(archive.read_bytes(), b'archive')
            self.assertTrue(final.is_dir())

    def test_archive_does_not_expose_build_machine_owner(self):
        info = tarfile.TarInfo('file')
        info.uid, info.gid, info.uname, info.gname = 501, 20, 'personal-name', 'staff'
        info.pax_headers = {'SCHILY.xattr.metadata': 'personal'}
        result = portable_header(info)
        self.assertEqual((result.uid, result.gid, result.uname, result.gname), (0, 0, 'root', 'root'))
        self.assertEqual(result.pax_headers, {})


if __name__ == '__main__':
    unittest.main()
