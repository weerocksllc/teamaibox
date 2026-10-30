from __future__ import annotations

import unittest

from tools.run_current_translation_product_successor import bind_parent


class CurrentTranslationProductSuccessorTests(unittest.TestCase):
    def test_parent_closes_task_without_certification_overclaim(self) -> None:
        value, _ = bind_parent()
        self.assertTrue(value["claimBoundary"]["task18_8Complete"])
        self.assertEqual(value["claimBoundary"]["translationProfileCertification"], "experimental")
        self.assertFalse(value["claimBoundary"]["releaseSoakComplete"])


if __name__ == "__main__":
    unittest.main()
