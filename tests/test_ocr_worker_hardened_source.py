import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class OcrWorkerHardenedSourceTest(unittest.TestCase):
    def test_predecode_and_prerender_limits_are_explicit(self):
        source = (ROOT / "services/ocr-worker/server_hardened.py").read_text(encoding="utf-8")
        self.assertLess(source.index("image.width * image.height > base.MAX_PIXELS"), source.index("image.load()"))
        self.assertLess(source.index("width * height > base.MAX_PIXELS"), source.index("page.get_pixmap"))

    def test_request_schema_and_media_type_are_fail_closed(self):
        source = (ROOT / "services/ocr-worker/server_hardened.py").read_text(encoding="utf-8")
        self.assertIn('media_type != "application/json"', source)
        self.assertIn('set(body) != {"file", "fileType"}', source)

    def test_image_runs_hardened_module(self):
        dockerfile = (ROOT / "deploy/images/ocr-worker.current-v2.Dockerfile").read_text(encoding="utf-8")
        self.assertIn("test_server_hardened.py", dockerfile)
        self.assertIn('"server_hardened:app"', dockerfile)


if __name__ == "__main__":
    unittest.main()
