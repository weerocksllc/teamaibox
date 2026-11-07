"""Affected preparation boundaries; all material is synthetic and temporary."""
import tempfile
import unittest
import hashlib
from pathlib import Path

from apply_opencode_transport_patch import apply, replace_once, source_tree


class TransportPatchBoundaries(unittest.TestCase):
    def test_complete_tree_covers_unlisted_files_modes_and_links(self):
        def oid(kind, value):
            return hashlib.sha1(kind + b' ' + str(len(value)).encode() + b'\0' + value).digest()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / 'extra.txt'
            target.write_bytes(b'synthetic')
            target.chmod(0o644)
            expected = oid(b'tree', b'100644 extra.txt\0' + oid(b'blob', b'synthetic'))
            self.assertEqual(source_tree(root), expected)
            target.chmod(0o755)
            self.assertNotEqual(source_tree(root), expected)
            (root / 'link').symlink_to('extra.txt')
            linked = source_tree(root)
            target.write_bytes(b'changed')
            self.assertNotEqual(source_tree(root), linked)

    def test_existing_output_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            output = root / 'existing'
            output.mkdir()
            sentinel = output / 'keep'
            sentinel.write_text('synthetic existing data')
            with self.assertRaises(Exception):
                apply(root / 'source', output)
            self.assertEqual(sentinel.read_text(), 'synthetic existing data')

    def test_changed_source_refused_without_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            source = root / 'source'
            target = source / 'packages/opencode/src/session/tools.ts'
            target.parent.mkdir(parents=True)
            target.write_text('not the pinned source')
            with self.assertRaisesRegex(Exception, 'OpenCode input mismatch'):
                apply(source, root / 'output')
            self.assertFalse((root / 'output').exists())
            self.assertEqual(target.read_text(), 'not the pinned source')

    def test_ambiguous_context_refused_without_edit(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'source.ts'
            target.write_text('old old')
            with self.assertRaisesRegex(Exception, 'context mismatch'):
                replace_once(target, 'old', 'new')
            self.assertEqual(target.read_text(), 'old old')

    def test_symlink_source_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / 'original').mkdir()
            (root / 'link').symlink_to(root / 'original', target_is_directory=True)
            with self.assertRaisesRegex(Exception, 'symlink'):
                apply(root / 'link', root / 'output')
            self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main()
