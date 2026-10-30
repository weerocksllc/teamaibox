from __future__ import annotations

import copy
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from tools.run_airplay_open_source_release_minimum import EVIDENCE_ROOT, canonical_digest
from tools.validate_airplay_open_source_release_minimum import validate


EVIDENCE = EVIDENCE_ROOT / "airplay-open-source-release-minimum-20260906-a4.json"


class AirPlayOpenSourceReleaseMinimumTest(unittest.TestCase):
    def setUp(self) -> None:
        self.value = json.loads(EVIDENCE.read_text(encoding="utf-8"))

    def temporary_evidence(self, value: dict[str, object], suffix: int) -> Path:
        run_id = f"airplay-open-source-release-minimum-20260906-a{suffix}"
        original_run_id = str(value["runId"])
        original_root = EVIDENCE_ROOT / original_run_id
        run_root = EVIDENCE_ROOT / run_id
        run_root.mkdir()
        linked: list[Path] = []
        for source in original_root.iterdir():
            destination = run_root / source.name
            os.link(source, destination)
            linked.append(destination)
        self.addCleanup(run_root.rmdir)
        for destination in linked:
            self.addCleanup(destination.unlink, missing_ok=True)
        for section, keys in (
            ("spdx", ("path",)),
            ("vulnerabilities", ("path",)),
            ("signature", ("subjectPath", "signaturePath", "publicKeyPath")),
        ):
            for key in keys:
                value[section][key] = str(value[section][key]).replace(original_run_id, run_id, 1)
        value["runId"] = run_id
        value["evidenceDigest"] = canonical_digest({
            key: item for key, item in value.items() if key != "evidenceDigest"
        })
        path = EVIDENCE_ROOT / f"{run_id}.json"
        self.addCleanup(path.unlink, missing_ok=True)
        path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        return path

    def verify_signature_locally(self, signature: bytes) -> bool:
        """Verify actual signed bytes without requiring a local Docker daemon.

        Cosign's locked-container integration remains separate. This is real
        ECDSA/SHA-256 verification, not a mocked success or a release waiver.
        """
        signature_record = self.value["signature"]
        with tempfile.TemporaryDirectory() as temporary:
            binary_signature = Path(temporary) / "signature.der"
            binary_signature.write_bytes(signature)
            process = subprocess.run([
                "openssl", "dgst", "-sha256", "-verify",
                str(EVIDENCE_ROOT / signature_record["publicKeyPath"]),
                "-signature", str(binary_signature),
                str(EVIDENCE_ROOT / signature_record["subjectPath"]),
            ], capture_output=True, timeout=10)
        return process.returncode == 0 and b"Verified OK" in process.stdout

    def test_exact_release_structure_and_offline_signature_do_not_claim_activation(self) -> None:
        signature = base64.b64decode((EVIDENCE_ROOT /
            self.value["signature"]["signaturePath"]).read_bytes(), validate=True)
        self.assertTrue(self.verify_signature_locally(signature))
        result = validate(EVIDENCE, revalidate_signature=False)
        self.assertTrue(result["valid"])
        self.assertTrue(result["signatureVerified"])
        self.assertEqual(result["criticalCount"], 0)
        self.assertTrue(result["task22_1Complete"])
        self.assertFalse(result["task22_3Complete"])

    def test_corrupt_offline_signature_is_rejected(self) -> None:
        signature = bytearray(base64.b64decode((EVIDENCE_ROOT /
            self.value["signature"]["signaturePath"]).read_bytes(), validate=True))
        signature[-1] ^= 1
        self.assertFalse(self.verify_signature_locally(bytes(signature)))

    @unittest.skipUnless(os.environ.get("TEAMAIBOX_RUN_DOCKER_INTEGRATION") == "1",
                         "locked Cosign container integration requires an explicit Docker test environment")
    def test_locked_cosign_container_signature_integration(self) -> None:
        self.assertTrue(validate(EVIDENCE)["signatureVerified"])

    def test_unsigned_evidence_mutation_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["image"]["receiverVersion"] = "mutable"
        path = EVIDENCE_ROOT / "airplay-open-source-release-minimum-20260906-a97.json"
        self.addCleanup(path.unlink, missing_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "digest drifted"):
            validate(path, revalidate_signature=False)

    def test_activation_overclaim_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["claimBoundary"]["task22_3Complete"] = True
        with self.assertRaisesRegex(ValueError, "overclaims"):
            validate(self.temporary_evidence(value, 98), revalidate_signature=False)

    def test_critical_finding_claim_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["vulnerabilities"]["criticalCount"] = 1
        value["vulnerabilities"]["unacceptedCriticalCount"] = 1
        with self.assertRaisesRegex(ValueError, "Critical vulnerability gate failed"):
            validate(self.temporary_evidence(value, 99), revalidate_signature=False)


if __name__ == "__main__":
    unittest.main()
