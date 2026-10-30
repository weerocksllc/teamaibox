import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_web_release_artifact as web


class WebReleaseSourcesTest(unittest.TestCase):
    def test_build_cache_is_not_source_but_code_changes_are_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'apps' / 'web'
            app.mkdir(parents=True)
            source = app / 'app.ts'
            cache = app / 'tsconfig.tsbuildinfo'
            source.write_text('export const version = 1;')
            cache.write_text('first build')
            with patch.object(web, 'ROOT', root), patch.object(web, 'SOURCE_ROOTS', (app,)):
                before = web.source_digest(web.source_files())
                cache.write_text('updated build cache')
                self.assertEqual(web.source_files(), [source])
                self.assertEqual(before, web.source_digest(web.source_files()))
                source.write_text('export const version = 2;')
                self.assertNotEqual(before, web.source_digest(web.source_files()))


if __name__ == '__main__':
    unittest.main()
