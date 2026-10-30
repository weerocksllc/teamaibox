from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

from tools.build_browser_trust_bundle import BrowserTrustBundleError, build_bundle


def certificate(directory: Path, *, ca: bool) -> tuple[Path, Path]:
    key = directory / ("ca.key" if ca else "leaf.key")
    cert = directory / ("ca.crt" if ca else "leaf.crt")
    arguments = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
        "-subj", "/CN=Team AI Box Test CA" if ca else "/CN=appliance.test",
        "-keyout", str(key), "-out", str(cert),
    ]
    if ca:
        arguments.extend(("-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"))
    subprocess.run(arguments, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


class BrowserTrustBundleTests(unittest.TestCase):
    def test_bundle_is_deterministic_public_only_and_never_claims_installation(self) -> None:
        with tempfile.TemporaryDirectory() as directory_text:
            directory = Path(directory_text)
            ca, _ = certificate(directory, ca=True)
            first = directory / "first.zip"
            second = directory / "second.zip"
            result = build_bundle(ca_path=ca, origin="https://10.64.0.18:18443/", label="Spark Worker 02", output=first)
            repeated = build_bundle(ca_path=ca, origin="https://10.64.0.18:18443", label="Spark Worker 02", output=second)
            self.assertEqual(result["bundleSha256"], repeated["bundleSha256"])
            self.assertFalse(result["containsPrivateKey"])
            self.assertFalse(result["installationPerformed"])
            self.assertFalse(result["browserTrustVerified"])
            self.assertFalse(result["releaseEvidenceEligible"])
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(sorted(archive.namelist()), ["README.txt", "manifest.json", "teamaibox-appliance-ca.crt"])
                payload = b"".join(archive.read(name) for name in archive.namelist())
                self.assertNotIn(b"PRIVATE KEY", payload)
                manifest = json.loads(archive.read("manifest.json"))
                self.assertFalse(manifest["installsTrustAutomatically"])
                self.assertEqual(manifest["applianceOrigin"], "https://10.64.0.18:18443")

    def test_rejects_leaf_private_key_http_and_unsafe_label(self) -> None:
        with tempfile.TemporaryDirectory() as directory_text:
            directory = Path(directory_text)
            leaf, key = certificate(directory, ca=False)
            output = directory / "bundle.zip"
            with self.assertRaisesRegex(BrowserTrustBundleError, "not a certificate authority"):
                build_bundle(ca_path=leaf, origin="https://appliance.test", label="Appliance", output=output)
            ca, _ = certificate(directory, ca=True)
            mixed = directory / "mixed.pem"
            mixed.write_bytes(ca.read_bytes() + key.read_bytes())
            with self.assertRaisesRegex(BrowserTrustBundleError, "private key"):
                build_bundle(ca_path=mixed, origin="https://appliance.test", label="Appliance", output=output)
            with self.assertRaisesRegex(BrowserTrustBundleError, "exact HTTPS origin"):
                build_bundle(ca_path=ca, origin="http://appliance.test", label="Appliance", output=output)
            with self.assertRaisesRegex(BrowserTrustBundleError, "label"):
                build_bundle(ca_path=ca, origin="https://appliance.test", label="../bad", output=output)


if __name__ == "__main__":
    unittest.main()
