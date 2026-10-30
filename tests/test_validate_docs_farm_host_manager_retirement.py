from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ValidateDocsFarmHostManagerRetirementTests(unittest.TestCase):
    def test_validator_rechecks_live_units_and_containers(self):
        source = (ROOT / "tools/validate_docs_farm_host_manager_retirement.py").read_text(encoding="utf-8")
        self.assertIn("live_units = unit_facts()", source)
        self.assertIn("live_containers = container_facts()", source)
        self.assertIn('row["ActiveState"] == "inactive"', source)
        self.assertIn('row["UnitFileState"] == "disabled"', source)
        self.assertIn('"containersPreserved": True', source)


if __name__ == "__main__":
    unittest.main()
