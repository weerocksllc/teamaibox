"""Check production image source closure without building or starting services."""
from pathlib import Path
import re
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]
IMAGES = [
    "deploy/images/platform-api.Dockerfile",
    "deploy/images/production-node-service.Dockerfile",
    "deploy/images/appliance-gateway.Dockerfile",
    "deploy/images/compute-gateway.Dockerfile",
    "deploy/appliance/object-service.Dockerfile",
    "deploy/appliance/messaging.Dockerfile",
]
IMAGES += [str(path.relative_to(ROOT)) for path in sorted((ROOT / "deploy/appliance").glob("*-plugin.Dockerfile"))]
IMPORT = re.compile(r"(?:\b(?:from|import)\s*\(?\s*|\bimport\s*)['\"](\.{1,2}/[^'\"]+)['\"]")


def repository_sources(dockerfile):
    sources = []
    for line in dockerfile.read_text().splitlines():
        if not line.startswith("COPY ") or "--from=" in line:
            continue
        fields = [value for value in shlex.split(line)[1:] if not value.startswith("--")]
        sources.extend((ROOT / value).resolve() for value in fields[:-1])
    return sources


class ApplianceImageSourcesTest(unittest.TestCase):
    def test_repository_copy_sources_exist(self):
        for name in IMAGES:
            for source in repository_sources(ROOT / name):
                with self.subTest(image=name, source=str(source)):
                    self.assertTrue(source.exists(), "Missing Docker COPY source")

    def test_runtime_relative_imports_are_included_in_image(self):
        for name in IMAGES:
            sources = repository_sources(ROOT / name)
            for base in sources:
                modules = base.rglob("*.mjs") if base.is_dir() else [base]
                for module in modules:
                    if module.suffix != ".mjs" or "test" in module.parts or "tests" in module.parts or module.name.endswith(".test.mjs"):
                        continue
                    # Public browser modules have URL aliases supplied by their
                    # static server (for example sha256.mjs), not disk imports.
                    if "public" in module.parts:
                        continue
                    for relative in IMPORT.findall(module.read_text()):
                        imported = (module.parent / relative).resolve()
                        with self.subTest(image=name, module=str(module.relative_to(ROOT)), imported=str(imported)):
                            self.assertTrue(imported.exists(), "Runtime relative import does not exist")
                            self.assertTrue(any(imported == source or source.is_dir() and source in imported.parents for source in sources),
                                            "Runtime import is absent from Docker COPY sources")


if __name__ == "__main__":
    unittest.main()
