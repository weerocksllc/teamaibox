from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
import tempfile
from unittest import mock

from tools.run_airplay_compatible_source_readiness import ROOT, canonical_digest, file_digest
from tools.validate_airplay_compatible_source_readiness import validate
from tools import validate_airplay_compatible_source_readiness as validator


def latest_current_evidence() -> Path:
    """Select the newest immutable record whose entire source set is current.

    The source-readiness packet intentionally binds this regression test.  A
    hard-coded run ID therefore creates a self-reference trap: updating the
    pointer changes the very source hash the pointed-to packet recorded.  The
    content match remains exact while allowing old packets to stay immutable.
    """

    root = ROOT / "evidence/validation/supply-chain"
    candidates = sorted(
        root.glob("airplay-compatible-source-readiness-*-a*.json"),
        key=lambda path: (
            path.stem.rsplit("-a", 1)[0].rsplit("-", 1)[1],
            int(path.stem.rsplit("-a", 1)[1]),
        ),
        reverse=True,
    )
    for path in candidates:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            records = value.get("sources")
            if not isinstance(records, list):
                continue
            if all(
                isinstance(record, dict)
                and isinstance(record.get("path"), str)
                and (ROOT / record["path"]).is_file()
                and record.get("sha256") == file_digest(ROOT / record["path"])
                for record in records
            ):
                # Matching hashes are necessary but not sufficient: reject a
                # correctly bound packet whose digest, claim boundary or
                # approval or fail-closed technical boundary was tampered independently.
                validate(path, revalidate=False)
                return path
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    raise RuntimeError("no immutable AirPlay source-readiness evidence matches the current source set")


# Historical packets test their schema, not current deployment eligibility.
# Requiring a fresh signed run while importing unit tests creates a circular
# dependency: the run itself hashes these tests.
EVIDENCE = sorted((ROOT / 'evidence/validation/supply-chain').glob(
    'airplay-compatible-source-readiness-*-a*.json'))[-1]


class AirPlayCompatibleSourceReadinessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.value = json.loads(EVIDENCE.read_text(encoding="utf-8"))
        self.directory = tempfile.TemporaryDirectory(prefix='source-readiness-unit-', dir=ROOT/'tmp')
        self.addCleanup(self.directory.cleanup)
        self.evidence_root = Path(self.directory.name)
        patcher = mock.patch.object(validator, 'EVIDENCE_ROOT', self.evidence_root)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Only this in-memory fixture follows workspace bytes. No run evidence
        # is created and no recorded checks are represented as rerun.
        self.value['sources'] = [dict(path=p, sha256=file_digest(ROOT/p))
                                for p in sorted(validator.EXPECTED_SOURCE_PATHS)]

    def temporary_evidence(self, value: dict[str, object]) -> Path:
        # The validator requires the controlled evidence directory.  Give each
        # mutation an unused valid identity and remove it after the assertion.
        run_id = "airplay-compatible-source-readiness-20260904-a99"
        value["runId"] = run_id
        value["evidenceDigest"] = canonical_digest({
            key: item for key, item in value.items() if key != "evidenceDigest"
        })
        path = self.evidence_root / f"{run_id}.json"
        self.addCleanup(path.unlink, missing_ok=True)
        path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        return path

    def test_in_memory_contract_does_not_claim_component_or_release_ready(self) -> None:
        result = validate(self.temporary_evidence(copy.deepcopy(self.value)), revalidate=False)
        self.assertTrue(result["valid"])
        self.assertTrue(result["sourceScaffoldReady"])
        self.assertTrue(result["componentContractReady"])
        self.assertFalse(result["componentReady"])
        self.assertFalse(result["releaseEligible"])
        self.assertFalse(result["task22_1Complete"])
        self.assertFalse(result["task22_3Complete"])
        self.assertEqual(result["approvedHumanDecisionCount"], 5)
        self.assertEqual(result["pendingHumanGateCount"], 0)

    def test_tampered_digest_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["candidatePins"]["receiver"] = "mutable-latest"
        run_id = "airplay-compatible-source-readiness-20260904-a98"
        value["runId"] = run_id
        path = self.evidence_root / f"{run_id}.json"
        self.addCleanup(path.unlink, missing_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "digest drifted"):
            validate(path, revalidate=False)

    def test_positive_legal_or_release_claim_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["claimBoundary"]["releaseEligible"] = True
        with self.assertRaisesRegex(ValueError, "overclaims"):
            validate(self.temporary_evidence(value), revalidate=False)

    def test_missing_source_binding_is_rejected(self) -> None:
        value = copy.deepcopy(self.value)
        value["sources"] = value["sources"][:-1]
        with self.assertRaisesRegex(ValueError, "binding count"):
            validate(self.temporary_evidence(value), revalidate=False)

    def test_rootfs_context_matches_the_scratch_dockerfile_copy_boundary(self) -> None:
        package = json.loads((ROOT / "deploy/casting/trusted-media-service.package.v1.json").read_text(encoding="utf-8"))
        dockerfile = (ROOT / package["build"]["dockerfile"]["path"]).read_text(encoding="utf-8")
        self.assertEqual(package["build"]["context"], "deploy/casting/trusted-media-service-rootfs")
        self.assertIn("COPY ./ /", dockerfile)
        self.assertNotIn("COPY --chown=", dockerfile)
        self.assertNotIn("COPY rootfs/ /", dockerfile)

    def test_user_and_operator_guide_is_complete_and_fail_closed(self) -> None:
        guide = (ROOT / "docs/operations/wireless-casting-guide.md").read_text(encoding="utf-8")
        for phrase in (
            "不代表 Apple 官方认证",
            "不支持受 FairPlay/DRM 保护的内容",
            "同一局域网",
            "观看人数按可用资源决定",
            "仅收到通知不会自动打开画面",
            "每次加入或重连都会重新检查权限并获取临时观看凭据",
            "默认不录制",
            "没有画面时",
            "安装、升级、回滚和卸载",
            "网页能打开不代表 Apple 音视频已经通过测试",
            "仅在浏览器中播放，不再支持 HDMI",
            "发起者的网页会自动加入观看",
            "不会因此获得他人私人投屏的观看权",
        ):
            self.assertIn(phrase, guide)
        self.assertNotIn("Apple 认证 AirPlay Receiver", guide)


if __name__ == "__main__":
    unittest.main()
