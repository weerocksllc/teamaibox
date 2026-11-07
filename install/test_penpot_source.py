import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from prepare_penpot_source import extract_source


class PenpotSourceTests(unittest.TestCase):
    def extract(self, entries):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'source.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                for name, link in entries:
                    member = tarfile.TarInfo(name)
                    if link is not None:
                        member.type, member.linkname = tarfile.SYMTYPE, link
                        bundle.addfile(member)
                    else:
                        member.size = 4
                        member.mode = 0o4755
                        bundle.addfile(member, io.BytesIO(b'test'))
            extract_source(archive, root / 'source', 'penpot-test')
            return [(p.name, p.read_text(), p.stat().st_mode & 0o7777)
                    for p in (root / 'source').iterdir()]

    def test_regular_files_strip_privileged_mode(self):
        self.assertEqual(self.extract([('penpot-test/main.txt', None)]), [('main.txt', 'test', 0o755)])

    def test_safe_upstream_sibling_link(self):
        self.assertEqual(len(self.extract([('penpot-test/main.txt', None),
                                          ('penpot-test/worker.txt', 'main.txt')])), 2)

    def test_reject_traversal_absolute_foreign_and_duplicate(self):
        for entries in [[('../outside', None)], [('/tmp/outside', None)], [('other/a', None)],
                        [('penpot-test/a', None), ('penpot-test/a', None)]]:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                self.extract(entries)

    def test_reject_link_escape_and_descendants(self):
        for entries in [[('penpot-test/link', '../outside')], [('penpot-test/link', '/tmp')],
                        [('penpot-test/link', 'target'), ('penpot-test/link/data', None)]]:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                self.extract(entries)


if __name__ == '__main__':
    unittest.main()
