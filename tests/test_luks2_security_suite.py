from __future__ import annotations

import unittest

from tools.validate_luks2_security_suite import validate


class Luks2SecuritySuiteTests(unittest.TestCase):
    def test_committed_suite_has_every_strict_scenario(self) -> None:
        result = validate()
        self.assertTrue(result["valid"])
        self.assertEqual(result["scenarioCount"], 14)
        self.assertTrue(result["requiresRealUsb"])
        self.assertRegex(result["suiteDigest"], r"^sha256:[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
