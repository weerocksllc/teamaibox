from __future__ import annotations

import unittest

from tools.spark_validation import ALLOWED_SPARK_TARGETS, RemoteSpark, SparkValidationError


class SparkLuks2RunnerTests(unittest.TestCase):
    def test_only_the_local_appliance_is_selectable(self) -> None:
        self.assertEqual(ALLOWED_SPARK_TARGETS, {
            "operator@10.64.0.20": "dgx-spark-dev-01",
        })
        self.assertEqual(RemoteSpark("operator@10.64.0.20").ssh_target, "operator@10.64.0.20")
        with self.assertRaisesRegex(SparkValidationError, "allowlisted"):
            RemoteSpark("operator@10.64.0.23")
        with self.assertRaisesRegex(SparkValidationError, "allowlisted"):
            RemoteSpark("operator@10.64.0.99")


if __name__ == "__main__":
    unittest.main()
