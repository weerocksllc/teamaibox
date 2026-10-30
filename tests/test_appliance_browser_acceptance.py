from __future__ import annotations

import copy
import datetime as dt
import json
import unittest

from tools.validate_appliance_browser_acceptance import SUITE, canonical_digest, combinations, validate_report


SHA = lambda value: "sha256:" + value * 64


def valid_report() -> dict:
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    matrix = []
    widths = {item["key"]: item["width"] for item in suite["matrix"]["viewports"]}
    for combination in combinations(suite):
        viewport, locale, theme = combination.split(".")
        matrix.append({
            "combination": combination,
            "actualWidth": widths[viewport],
            "documentLanguage": locale,
            "effectiveTheme": theme,
            "result": "passed",
        })
    value = {
        "schemaVersion": 1,
        "suiteId": suite["suiteId"],
        "suiteDigest": canonical_digest(suite),
        "runId": "appliance-browser-20260812-a1",
        "releaseCandidateId": "rc-test-1",
        "outcome": "passed",
        "releaseEvidenceEligible": True,
        "startedAt": "2026-08-12T00:30:00Z",
        "finishedAt": "2026-08-12T01:00:00Z",
        "target": {
            "nodeId": "dgx-spark-dev-01",
            "architecture": "linux/arm64/v8",
            "supportedContainerizedAppliance": True,
            "hostAllowlistConforming": True,
            "hostAllowlistDriftCount": 0,
        },
        "origin": {
            "url": "https://10.64.0.20/",
            "originClass": "supported-appliance-authenticated-https",
            "certificateTrust": "private-appliance-ca-browser-trusted",
            "certificateFingerprintSha256": SHA("1"),
            "leafHostnameOrIpMatched": True,
            "browserTrustStoreVerified": True,
            "warningBypassUsed": False,
            "customClientCaUsed": False,
        },
        "deployment": {"releaseEvidenceEligible": True, "evidenceDigest": SHA("2")},
        "hardwareCheckpoint": {
            "current": True,
            "capturedAt": "2026-08-12T00:00:00Z",
            "ageAtCompletionSeconds": 3600,
            "maximumAgeSeconds": 3600,
            "evidenceDigest": SHA("3"),
        },
        "browser": {"name": "Chromium", "version": "140.0.0", "execution": "real-browser", "certificateErrorCount": 0, "consoleErrorCount": 0},
        "matrix": matrix,
        "journeys": {
            key: [{"step": step, "result": "passed"} for step in suite["journeys"][key]]
            for key in ("administrator", "ordinaryUser", "transport")
        },
        "privacy": suite["artifactPolicy"],
        "sourceEvidence": {
            "deploymentEvidenceDigest": SHA("2"),
            "hostDriftEvidenceDigest": SHA("4"),
            "hardwareEvidenceDigest": SHA("3"),
            "browserArtifactDigest": SHA("5"),
        },
    }
    value["evidenceDigest"] = canonical_digest(value)
    return value


def redigest(value: dict) -> dict:
    value["evidenceDigest"] = canonical_digest({key: item for key, item in value.items() if key != "evidenceDigest"})
    return value


class ApplianceBrowserAcceptanceTests(unittest.TestCase):
    def test_complete_real_browser_appliance_report_derives_release_claims(self) -> None:
        result = validate_report(valid_report(), evaluated_at=dt.datetime(2026, 8, 12, 2, tzinfo=dt.timezone.utc))
        self.assertTrue(result["valid"])
        self.assertEqual(result["claims"]["matrixCombinationCount"], 8)
        self.assertTrue(result["claims"]["administratorJourneyPassed"])
        self.assertEqual(result["claims"]["browserEvidenceDigest"], result["evidenceDigest"])

    def test_http_development_ca_and_trust_bypasses_fail_closed(self) -> None:
        mutations = []
        http = valid_report()
        http["origin"]["url"] = "http://10.64.0.20/"
        mutations.append(http)
        port = valid_report()
        port["origin"]["url"] = "https://10.64.0.20:18443/"
        mutations.append(port)
        development_ca = valid_report()
        development_ca["origin"]["certificateTrust"] = "development-CA-not-installed-in-browser-trust-store"
        mutations.append(development_ca)
        bypass = valid_report()
        bypass["origin"]["warningBypassUsed"] = True
        mutations.append(bypass)
        custom_ca = valid_report()
        custom_ca["origin"]["customClientCaUsed"] = True
        mutations.append(custom_ca)
        for value in mutations:
            with self.subTest(origin=value["origin"]), self.assertRaises(ValueError):
                validate_report(redigest(value), evaluated_at=dt.datetime(2026, 8, 12, 2, tzinfo=dt.timezone.utc))

    def test_missing_matrix_journey_stale_hardware_and_retained_credentials_fail(self) -> None:
        mutations = []
        matrix = valid_report()
        matrix["matrix"].pop()
        mutations.append(matrix)
        journey = valid_report()
        journey["journeys"]["ordinaryUser"].pop()
        mutations.append(journey)
        stale = valid_report()
        stale["hardwareCheckpoint"]["ageAtCompletionSeconds"] = 3601
        mutations.append(stale)
        retained = valid_report()
        retained["privacy"]["credentialsRetained"] = True
        mutations.append(retained)
        for value in mutations:
            with self.subTest(keys=value.keys()), self.assertRaises(ValueError):
                validate_report(redigest(value), evaluated_at=dt.datetime(2026, 8, 12, 2, tzinfo=dt.timezone.utc))

    def test_digest_tampering_fails_closed(self) -> None:
        value = copy.deepcopy(valid_report())
        value["browser"]["version"] = "changed"
        with self.assertRaisesRegex(ValueError, "digest"):
            validate_report(value, evaluated_at=dt.datetime(2026, 8, 12, 2, tzinfo=dt.timezone.utc))


if __name__ == "__main__":
    unittest.main()
