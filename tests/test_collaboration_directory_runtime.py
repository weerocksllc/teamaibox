import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class CollaborationDirectoryRuntimeTest(unittest.TestCase):
    def test_overlay_contains_only_directory_runtime_files(self):
        dockerfile = (ROOT / "deploy/application-catalog-e2e/PlatformApiCollaborationDirectoryRuntime.Dockerfile").read_text()
        for path in ("identity-directory-http-api.mjs", "identity-directory-service.mjs", "postgres-repository.mjs", "memory-repository.mjs"):
            self.assertIn(path, dockerfile)
        self.assertNotIn("COPY .", dockerfile)


if __name__ == "__main__":
    unittest.main()
