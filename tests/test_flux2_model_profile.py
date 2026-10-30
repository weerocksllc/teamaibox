import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "deploy/application-catalog-e2e/drawing-flux2-klein-nvfp4-provider-profile.validating.v1.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


class Flux2ModelProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.value = json.loads(PROFILE.read_text(encoding="utf-8"))

    def test_exact_identity_and_fail_closed_lifecycle(self):
        self.assertEqual(self.value["profileId"], "bc266009-bf57-589e-b8c4-dcf9ec892692")
        self.assertEqual(self.value["profileKey"], "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1")
        self.assertEqual(self.value["certification"]["state"], "validating")
        self.assertNotEqual(self.value["certification"]["state"], "certified")
        self.assertTrue(self.value["exclusive"])

    def test_exact_nvfp4_and_runtime_facts(self):
        self.assertEqual(self.value["precision"], "nvfp4")
        self.assertEqual(self.value["quantizationRecipe"]["scheme"], "nvfp4")
        self.assertEqual(self.value["extensions"]["effective_steps"], 4)
        self.assertEqual(self.value["extensions"]["effective_guidance_scale"], 1.0)
        self.assertIn("negative_prompt", self.value["extensions"]["unsupported_modes"])
        self.assertEqual(self.value["engine"]["imageDigest"],
                         "sha256:200c5ab92b8d66792b2d756c6c8f56906e25f3e633e33f2d2927d5f3d33c4d04")

    def test_evidence_and_artifacts_are_digest_pinned(self):
        self.assertGreaterEqual(len(self.value["validationEvidence"]), 5)
        self.assertTrue(all(item["result"] == "passed" and SHA256.fullmatch(item["environmentDigest"])
                            for item in self.value["validationEvidence"]))
        self.assertTrue(all(SHA256.fullmatch(item["digest"]) and item["sizeBytes"] > 0
                            for item in self.value["artifacts"]))
        self.assertEqual(self.value["artifactDigest"], self.value["artifacts"][0]["digest"])

    def test_product_claims_remain_truthful(self):
        limitations = " ".join(self.value["knownLimitations"])
        self.assertIn("not Certified", limitations)
        self.assertIn("slower than BF16 for warm requests", limitations)
        self.assertEqual(self.value["executionKind"], "external_provider")
        self.assertEqual(self.value["extensions"]["processing_location"], "managed_lan_node")


if __name__ == "__main__":
    unittest.main()
