#!/usr/bin/env python3
"""Qualify the exact published Drawing portfolio and upstream metadata snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any

try:
    from .run_spark_model_baseline import canonical_digest, utc_now
    from .validate_drawing_model_portfolio import PORTFOLIO, validate
except ImportError:
    from run_spark_model_baseline import canonical_digest, utc_now
    from validate_drawing_model_portfolio import PORTFOLIO, validate


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = re.compile(r"^drawing-model-portfolio-[0-9]{8}-a[1-9][0-9]*$")
RUNNER = ROOT / "tools" / "run_drawing_model_portfolio_qualification.py"
VALIDATOR = ROOT / "tools" / "validate_drawing_model_portfolio_qualification.py"
PORTFOLIO_VALIDATOR = ROOT / "tools" / "validate_drawing_model_portfolio.py"
TEST = ROOT / "tests" / "test_drawing_model_portfolio.py"
README = ROOT / "models" / "README.md"
SOURCES = (PORTFOLIO, PORTFOLIO_VALIDATOR, RUNNER, VALIDATOR, TEST, README)


class QualificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def fetch(url: str, timeout: int = 120) -> bytes:
    require(url.startswith("https://") and "@" not in url.split("/", 3)[2], "unsafe metadata URL")
    completed = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", str(timeout), url],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 10, check=False,
    )
    require(completed.returncode == 0, "official metadata fetch failed")
    return completed.stdout


def source(path: Path) -> dict[str, str]:
    require(path.is_file() and path.is_relative_to(ROOT), "portfolio qualification source is missing")
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path.read_bytes())}


def upstream_local(candidate: dict[str, Any]) -> dict[str, Any]:
    declared = candidate["source"]
    repository = declared["repository"]
    metadata_url = f"https://huggingface.co/api/models/{repository}?blobs=true"
    metadata_raw = fetch(metadata_url)
    metadata = json.loads(metadata_raw)
    require(metadata.get("id") == repository and metadata.get("sha") == declared["revision"],
            "official repository revision drifted: " + repository)
    require(metadata.get("private") is False and metadata.get("gated") is False,
            "official repository access boundary drifted: " + repository)
    require(metadata.get("usedStorage") == declared["reportedBytes"],
            "official repository size drifted: " + repository)
    manifest = sorted(({
        "path": item["rfilename"],
        "bytes": item["size"],
        "digest": ("sha256:" + item["lfs"]["sha256"] if item.get("lfs")
                   else "git-sha1:" + item["blobId"]),
    } for item in metadata["siblings"]), key=lambda item: item["path"])
    manifest_digest = canonical_digest(manifest)
    require(manifest_digest == declared["artifactManifestDigest"],
            "official repository manifest drifted: " + repository)
    license_record = candidate["license"]
    license_url = (f"https://huggingface.co/{repository}/resolve/{declared['revision']}/"
                   f"{license_record['evidencePath']}")
    license_digest = digest(fetch(license_url))
    require(license_digest == license_record["evidenceDigest"],
            "official license evidence drifted: " + repository)
    return {
        "candidateId": candidate["candidateId"], "repository": repository,
        "revision": declared["revision"], "reportedBytes": declared["reportedBytes"],
        "artifactManifestDigest": manifest_digest, "licenseEvidenceDigest": license_digest,
        "metadataUrl": metadata_url, "access": "public-ungated", "passed": True,
    }


def upstream_external(candidate: dict[str, Any]) -> dict[str, Any]:
    body = fetch(candidate["contractUri"])
    body_text = body.decode("utf-8", errors="ignore")
    facts = candidate["contractFacts"]
    require(canonical_digest(facts) == candidate["contractSnapshotDigest"],
            "provider contract fact digest drifted: " + candidate["candidateId"])
    tokens = ([facts["modelId"], "1-3", "reference images"]
              if candidate["candidateId"] == "qwen-image-3.0-pro"
              else [facts["modelId"], "4096", "2048", "up to 9"])
    require(all(token in body_text for token in tokens),
            "provider contract no longer exposes the pinned facts: " + candidate["candidateId"])
    return {
        "candidateId": candidate["candidateId"], "provider": candidate["provider"],
        "modelId": candidate["modelId"], "contractUri": candidate["contractUri"],
        "contractSnapshotDigest": candidate["contractSnapshotDigest"],
        "fetchedContentDigest": digest(body), "passed": True,
    }


def run(run_id: str, output: Path) -> dict[str, Any]:
    require(RUN_ID.fullmatch(run_id) is not None, "unsafe Drawing portfolio run identity")
    require(output.is_relative_to(ROOT) and not output.exists(), "Drawing portfolio evidence path is unsafe or occupied")
    started = utc_now()
    try:
        for path in SOURCES:
            require(path.is_file(), "Drawing portfolio qualification input is missing")
        portfolio = json.loads(PORTFOLIO.read_text(encoding="utf-8"))
        summary = validate(portfolio)
        tests = subprocess.run(
            ["python3", "-m", "unittest", "tests.test_drawing_model_portfolio"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False,
        )
        require(tests.returncode == 0, "Drawing portfolio source tests failed")
        local_checks = [upstream_local(item) for item in portfolio["localCandidates"]]
        external_checks = [upstream_external(item) for item in portfolio["externalCandidates"]]
        report: dict[str, Any] = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.drawing-model-portfolio-qualification.v1",
            "runId": run_id,
            "status": "passed",
            "startedAt": started,
            "completedAt": utc_now(),
            "portfolio": {"portfolioId": portfolio["portfolioId"], "sha256": digest(PORTFOLIO.read_bytes()),
                          "summary": summary},
            "upstream": {"localCandidates": local_checks, "externalCandidates": external_checks,
                         "allPassed": True},
            "tests": {"command": "python3 -m unittest tests.test_drawing_model_portfolio",
                      "exitCode": 0, "outputRetained": False,
                      "stdoutDigest": digest(tests.stdout), "stderrDigest": digest(tests.stderr)},
            "claimBoundary": {"task7_18Complete": True, "modelsDownloaded": False,
                              "modelsDeployed": False, "modelsCertified": False,
                              "automaticRoutingEnabled": False, "task7_19Complete": False,
                              "task7_20Complete": False, "task7_21Complete": False,
                              "task7_22Complete": False, "task8_2Complete": False,
                              "task18_5Complete": False},
            "sources": [source(path) for path in SOURCES],
            "privacy": {"credentialsUsed": False, "credentialsRetained": False,
                        "userContentUsed": False, "commandOutputRetained": False},
            "failure": None,
        }
    except Exception as error:
        report = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.drawing-model-portfolio-qualification.v1",
            "runId": run_id,
            "status": "failed",
            "startedAt": started,
            "completedAt": utc_now(),
            "portfolio": None,
            "upstream": {"localCandidates": [], "externalCandidates": [], "allPassed": False},
            "tests": None,
            "claimBoundary": {"task7_18Complete": False, "modelsDownloaded": False,
                              "modelsDeployed": False, "modelsCertified": False,
                              "automaticRoutingEnabled": False},
            "sources": [source(path) for path in SOURCES if path.is_file()],
            "privacy": {"credentialsUsed": False, "credentialsRetained": False,
                        "userContentUsed": False, "commandOutputRetained": False},
            "failure": {"type": type(error).__name__, "message": str(error)[:1600]},
        }
    report["evidenceDigest"] = canonical_digest(report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
                      encoding="utf-8")
    require(report["status"] == "passed", "Drawing portfolio qualification failed: " + str(report["failure"]))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    output = ROOT / "evidence" / "validation" / "model-candidates" / f"{args.run_id}.json"
    value = run(args.run_id, output)
    print(json.dumps({"runId": args.run_id, "status": value["status"],
                      "evidence": output.relative_to(ROOT).as_posix(),
                      "evidenceDigest": value["evidenceDigest"]}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, QualificationError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f"Drawing portfolio qualification failed: {error}")
