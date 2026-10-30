import unittest

from tools.validate_model_coexistence_suite import validate


class ModelCoexistenceSuiteTests(unittest.TestCase):
    def test_suite_covers_shared_exclusive_and_core_pressure_boundaries(self):
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["sharedCapabilityCount"], 5)
        self.assertEqual(result["phaseCount"], 2)
        self.assertLessEqual(result["totalSharedMemoryTouchBytes"], 24 * 1024**3)
        self.assertEqual(result["maximumExclusiveMemoryTouchBytes"], 24 * 1024**3)


if __name__ == "__main__":
    unittest.main()
