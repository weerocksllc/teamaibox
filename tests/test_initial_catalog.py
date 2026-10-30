import copy, json, pathlib, tempfile, unittest
from unittest import mock
from tools import validate_initial_catalog as catalog

class InitialCatalogTests(unittest.TestCase):
    def test_initial_catalog_excludes_video_generation(self):
        self.assertEqual(catalog.validate(), {"applications": 10, "containerPlugins": 9, "candidateWorkloads": 6})

    def test_current_policy_contains_both_user_approved_guest_apps(self):
        policy = json.loads(catalog.POLICY.read_text())
        self.assertIn('official.virtual-phones', policy['firstPartyApplicationIds'])
        self.assertIn('official.virtual-computers', policy['firstPartyApplicationIds'])
        self.assertEqual(policy['supersedes'], 'initial-official-catalog-no-video-generation.v1')

    def test_policy_cannot_silently_add_video_generation(self):
        policy = json.loads(catalog.POLICY.read_text())
        drifted = copy.deepcopy(policy)
        drifted["firstPartyApplicationIds"].append("official.video-generation")
        with tempfile.TemporaryDirectory() as directory:
            policy_path = pathlib.Path(directory) / "initial-catalog-policy.v1.json"
            policy_path.write_text(json.dumps(drifted))
            with mock.patch.object(catalog, "POLICY", policy_path):
                with self.assertRaisesRegex(ValueError, "catalog drifted"):
                    catalog.validate()

if __name__ == "__main__": unittest.main()
