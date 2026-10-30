from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RetireDocsFarmHostManagersTests(unittest.TestCase):
    def test_retirement_is_exact_reversible_and_preserves_containers(self):
        source = (ROOT / "tools/retire_docs_farm_host_managers.py").read_text(encoding="utf-8")
        self.assertEqual(source.count('"docs-farm-') - source.count('startswith(("docs-farm-'), 19)
        self.assertIn('run_systemctl("disable")', source)
        self.assertIn('run_systemctl("enable")', source)
        self.assertIn('after_containers == before_containers', source)
        self.assertIn('"containersDeleted": False', source)
        self.assertIn('"volumesDeleted": False', source)
        self.assertNotIn('docker rm', source)
        self.assertNotIn('rm -', source)


if __name__ == "__main__":
    unittest.main()
