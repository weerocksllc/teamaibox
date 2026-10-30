from __future__ import annotations

import unittest

from tools.run_current_supported_environment_v2_qualification import CATALOG, MATRIX, artifact


class CurrentSupportedEnvironmentV2QualificationTests(unittest.TestCase):
    def test_exact_current_artifacts_are_bound(self) -> None:
        matrix, matrix_binding = artifact(MATRIX, "matrixId", "teamaibox.supported-environment.v2")
        catalog, catalog_binding = artifact(CATALOG, "catalogId", "teamaibox.feature-acceptance.v6")
        self.assertEqual(matrix_binding["fileSha256"][:7], "sha256:")
        self.assertEqual(catalog_binding["fileSha256"][:7], "sha256:")
        self.assertTrue(matrix["gatePolicy"]["task20_5Satisfied"])
        self.assertEqual(catalog["technicalClosure"]["productAcceptedCount"], 10)


if __name__ == "__main__":
    unittest.main()
