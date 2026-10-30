from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TrustedBrowserPreloadTests(unittest.TestCase):
    def test_preload_removes_every_certificate_bypass(self):
        source = (ROOT / "tools/trusted_browser_preload.mjs").read_text(encoding="utf-8")
        self.assertIn('"--ignore-certificate-errors"', source)
        self.assertIn('"--allow-insecure-localhost"', source)
        self.assertIn('"--test-type"', source)
        self.assertIn("actualArgs = args.filter", source)
        self.assertIn("syncBuiltinESMExports()", source)
        self.assertIn("certificateBypassArgumentsPresent: false", source)
        self.assertIn("systemTrustOnly: true", source)
        self.assertNotIn("NODE_EXTRA_CA_CERTS", source)


if __name__ == "__main__":
    unittest.main()
