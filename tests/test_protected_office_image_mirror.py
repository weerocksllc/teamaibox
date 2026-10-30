import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


runner = load("protected_office_image_mirror", "tools/mirror_protected_office_images.py")
validator = load("validate_protected_office_image_mirror", "tools/validate_protected_office_image_mirror.py")


class ProtectedOfficeImageMirrorTests(unittest.TestCase):
    def test_declaration_has_exact_seven_identities(self):
        value = runner.validate_declaration(json.loads(runner.DECLARATION.read_text(encoding="utf-8")))
        self.assertEqual(len(value["images"]), 7)
        self.assertEqual({item["key"] for item in value["images"]}, {
            "embedding-qwen3", "asr-whisper", "ocr-hunyuan", "ocr-hunyuan-provider",
            "translation-lmt4", "assistant-qwen38", "drawing-flux2",
        })

    def test_manifest_digest_is_distinct_from_config_identity_contract(self):
        value = runner.validate_declaration(json.loads(runner.DECLARATION.read_text(encoding="utf-8")))
        for item in value["images"]:
            self.assertRegex(item["sourceImageId"], r"^sha256:[0-9a-f]{64}$")
            self.assertNotIn("@", item["sourceImageId"])

    def test_immutable_writer_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "evidence.json"
            runner.immutable_write(path, {"status": "first"})
            with self.assertRaises(FileExistsError):
                runner.immutable_write(path, {"status": "second"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"status": "first"})

    def test_validator_binds_its_own_source(self):
        source = (ROOT / "tools/validate_protected_office_image_mirror.py").read_text(encoding="utf-8")
        self.assertIn('"tools/validate_protected_office_image_mirror.py"', source)
        self.assertIn("task21_4Complete", source)


if __name__ == "__main__":
    unittest.main()
