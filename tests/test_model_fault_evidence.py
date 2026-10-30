import unittest

from tools.validate_model_fault_evidence import validate


class ModelFaultEvidenceTests(unittest.TestCase):
    def test_both_release_candidates_pass_every_fault_fail_closed(self):
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["releaseCandidateCount"], 2)
        self.assertEqual(result["caseCountPerCandidate"], 10)
        self.assertTrue(all(item["coreServiceReserveMarginBytes"] > 0 for item in result["reports"]))
        self.assertEqual({item["oomClassification"] for item in result["reports"]}, {"cgroup_oom_killed"})


if __name__ == "__main__":
    unittest.main()
