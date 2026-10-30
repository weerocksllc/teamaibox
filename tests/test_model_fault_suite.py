import unittest

from tools.validate_model_fault_suite import validate


class ModelFaultSuiteTests(unittest.TestCase):
    def test_every_required_fault_and_candidate_is_pinned(self):
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["releaseCandidateCount"], 2)
        self.assertEqual(result["caseCount"], 10)


if __name__ == "__main__":
    unittest.main()
