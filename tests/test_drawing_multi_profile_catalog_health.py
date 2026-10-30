import unittest
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy/application-catalog-e2e/refresh-health.sh"


class DrawingMultiProfileCatalogHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SCRIPT.read_text(encoding="utf-8")

    def test_drawing_health_is_capability_based(self):
        self.assertEqual(cls_count := self.source.count(
            "profile.capability_id='d3a3c816-06de-4fe7-9063-f50f4dd2d8af'::uuid"), 2)
        self.assertEqual(cls_count, 2)
        self.assertNotIn("profile.profile_key='drawing.sdxl", self.source)

    def test_generation_and_editing_are_both_required(self):
        self.assertEqual(self.source.count("mapping.operations ? 'images.generations'"), 2)
        self.assertEqual(self.source.count("mapping.operations ? 'images.edits'"), 2)

    def test_certified_or_explicitly_opted_in_profiles_are_eligible(self):
        self.assertEqual(self.source.count(
            "profile.certification_state='certified' OR opt_in.id IS NOT NULL"), 4)
        self.assertGreaterEqual(self.source.count("opt_in.expires_at>clock_timestamp()"), 4)

    def test_plugin_probes_cannot_forge_managed_node_heartbeats(self):
        updates = re.findall(r"UPDATE compute\.nodes\b[^;]+;", self.source)
        self.assertEqual(len(updates), 2)
        for update in updates:
            where = update.split("WHERE node_key=", 1)[1]
            self.assertIn("trust_kind <> 'managed_appliance'", where)


if __name__ == "__main__":
    unittest.main()
