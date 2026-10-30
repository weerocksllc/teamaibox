import pathlib
import unittest

from tools.run_z_image_turbo_qualification import PARENTS, PROFILE_KEY, RUN_ID, SOURCES


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ZImageTurboQualificationTests(unittest.TestCase):
    def test_exact_parent_chain_and_identity(self):
        self.assertEqual(set(PARENTS), {"candidate", "runtimeSmoke", "quality"})
        self.assertIn("a2.json", PARENTS["runtimeSmoke"][0])
        self.assertIn("a2.json", PARENTS["quality"][0])
        self.assertIsNotNone(RUN_ID.fullmatch("z-image-turbo-qualification-20260901-a1"))
        self.assertTrue(PROFILE_KEY.startswith("drawing.z-image-turbo"))
        self.assertTrue(all((ROOT / relative).is_file() for relative in SOURCES))

    def test_all_task_7_20_gates_are_explicit(self):
        source = (ROOT / "tools/run_z_image_turbo_qualification.py").read_text(encoding="utf-8")
        for key in ("exactRevisionAndManifest", "generation", "editingDisabled", "multiReferenceDisabled",
                    "englishText", "chineseText", "portrait", "product", "diversity",
                    "commonQualityCorpus", "coldWarmLatency", "peakUnifiedMemory", "cancellation",
                    "unloadReload", "sameSeedReproducibility", "security", "coexistence"):
            self.assertIn(f'"{key}": True', source)

    def test_candidate_is_not_silently_routed_or_certified(self):
        for relative in ("tools/run_z_image_turbo_qualification.py",
                         "tools/validate_z_image_turbo_qualification.py"):
            source = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn('"certification": "validating"', source)
            self.assertIn('"certified": False', source)
            self.assertIn('"productRouted": False', source)
            self.assertIn('"productAccepted": False', source)


if __name__ == "__main__":
    unittest.main()
