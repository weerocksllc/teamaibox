import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import create_casting_catalog_successor as successor


class CastingCatalogSuccessorTest(unittest.TestCase):
    def setUp(self):
        self.documents = successor.expected()

    def test_exact_successor_is_valid(self):
        result = successor.validate_documents(self.documents)
        self.assertTrue(result["task22_15Accepted"])
        self.assertFalse(result["airplaySenderProductAccepted"])

    def test_airplay_cannot_be_optional(self):
        documents = copy.deepcopy(self.documents)
        feature = next(row for row in documents[successor.CATALOG]["features"]
                       if row["key"] == "integration.airplay-receiver")
        feature["mandatory"] = False
        with self.assertRaisesRegex(ValueError, "casting_catalog_or_matrix_changed"):
            successor.validate_documents(documents)

    def test_airplay_product_acceptance_cannot_be_invented(self):
        documents = copy.deepcopy(self.documents)
        feature = next(row for row in documents[successor.CATALOG]["features"]
                       if row["key"] == "integration.airplay-receiver")
        feature["acceptance"]["productAccepted"] = True
        with self.assertRaisesRegex(ValueError, "casting_catalog_or_matrix_changed"):
            successor.validate_documents(documents)

    def test_hdmi_retirement_cannot_be_marked_passed(self):
        documents = copy.deepcopy(self.documents)
        documents[successor.CATALOG]["retiredFeatures"][0]["passed"] = True
        with self.assertRaisesRegex(ValueError, "casting_catalog_or_matrix_changed"):
            successor.validate_documents(documents)

    def test_unrelated_feature_cannot_change(self):
        documents = copy.deepcopy(self.documents)
        feature = next(row for row in documents[successor.CATALOG]["features"]
                       if row["key"] not in successor.CASTING_KEYS)
        feature["acceptance"]["productAccepted"] = not feature["acceptance"]["productAccepted"]
        with self.assertRaisesRegex(ValueError, "casting_catalog_or_matrix_changed"):
            successor.validate_documents(documents)


if __name__ == "__main__":
    unittest.main()
