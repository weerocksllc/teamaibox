import unittest

from tools.validate_model_soak_suite import validate


class ModelSoakSuiteTests(unittest.TestCase):
    def test_nvfp4_is_the_exact_risk_selected_24_hour_candidate(self):
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["selectedProfileKey"], "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1")
        self.assertEqual(result["requiredDurationSeconds"], 86400)


if __name__ == "__main__":
    unittest.main()
