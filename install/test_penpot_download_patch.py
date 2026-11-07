import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import penpot_download_patch as native


class NativeDownloadPatchTests(unittest.TestCase):
    def test_version_guard_and_exact_native_call_sites(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            path = source / native.INPUT
            path.parent.mkdir(parents=True)
            original = ('(ns app.util.dom\n  (:require\n))\n'
                        '    (obj/set! link "href" uri)\n'
                        'response    (js/fetch uri)\n')
            path.write_text(original)
            with self.assertRaises(RuntimeError):
                native.patch(source)
            self.assertEqual(path.read_text(), original)
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(native, 'SHA256', expected):
                native.patch(source)
                with self.assertRaises(RuntimeError):
                    native.patch(source)
            self.assertEqual(path.read_text().count('tab-download/resolveDownload'), 2)
            self.assertTrue(path.with_name('teamaibox_download.js').is_file())

    def test_changed_call_site_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            path = source / native.INPUT
            path.parent.mkdir(parents=True)
            path.write_text('(ns app.util.dom\n  (:require\n))\n')
            original = path.read_bytes()
            with patch.object(native, 'SHA256', hashlib.sha256(original).hexdigest()), self.assertRaises(RuntimeError):
                native.patch(source)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(path.with_name('teamaibox_download.js').exists())


if __name__ == '__main__':
    unittest.main()
