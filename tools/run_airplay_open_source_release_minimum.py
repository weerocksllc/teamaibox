#!/usr/bin/env python3
"""Qualify the simplified open-source ARM64 trusted-media release minimum."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
from datetime import datetime, timezone
from typing import Any, Sequence
from urllib.request import Request, urlopen

try:
    from .validate_airplay_compatible_supply_chain_review import validate as validate_review
except ImportError:
    from validate_airplay_compatible_supply_chain_review import validate as validate_review


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence/validation/supply-chain"
RUN_ID = re.compile(r"^airplay-open-source-release-minimum-[0-9]{8}-a[0-9]+$")
IMAGE = "teamaibox/trusted-media-service:open-source-v2"
LOCK = ROOT / "deploy/casting/airplay-compatible-stack.lock.v2.json"
REVIEW = ROOT / "architecture/validation/airplay-compatible-supply-chain-review.v3.json"
SOURCE_PATHS = (
    "architecture/validation/airplay-compatible-supply-chain-review.v3.json",
    "deploy/casting/TrustedMediaService.arm64.v2.Dockerfile",
    "deploy/casting/airplay-compatible-stack.lock.v2.json",
    "deploy/casting/trusted-media-container/media-health",
    "deploy/casting/trusted-media-container/teamaibox-media-supervisor",
    "deploy/legal/airplay-compatible/NOTICE.v2.txt",
    "docs/operations/airplay-compatible-open-source-release-minimum.v3.md",
    "docs/operations/trusted-media-open-source-build.v2.md",
    "tools/run_airplay_open_source_release_minimum.py",
    "tools/validate_airplay_open_source_release_minimum.py",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def file_digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def canonical_digest(value: dict[str, Any]) -> str:
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def command(argv: Sequence[str], *, timeout: int = 900, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(list(argv), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode != 0:
        error = result.stderr.decode("utf-8", "replace")[-2000:].strip()
        raise RuntimeError(f"command failed ({argv[0]}, exit={result.returncode}): {error}")
    return result


def docker_tool(image: str, arguments: Sequence[str], *, timeout: int = 900,
                docker_socket: bool = False, work: Path | None = None,
                env_file: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    tool_user = "0:0" if docker_socket else f"{os.getuid()}:{os.getgid()}"
    # Grype 0.118 expands its signed database above 1 GiB while updating.
    # A run-scoped tmpfs keeps that cache ephemeral without constraining it
    # below the tool's real current working set.
    cache_size = "4g"
    argv = [
        "docker", "run", "--rm", "--platform", "linux/arm64/v8",
        "--user", tool_user,
        "--tmpfs", f"/tmp:rw,nosuid,nodev,size={cache_size},mode=1777",
        "--env", "XDG_CACHE_HOME=/tmp/.cache",
        "--env", "HOME=/tmp/home",
    ]
    if docker_socket:
        argv.extend(["--volume", "/var/run/docker.sock:/var/run/docker.sock"])
    if work is not None:
        argv.extend(["--volume", f"{work.resolve()}:/work"])
    if env_file is not None:
        argv.extend(["--env-file", str(env_file.resolve())])
    argv.extend([image, *arguments])
    return command(argv, timeout=timeout)


def inspect_image(reference: str) -> dict[str, Any]:
    output = command(["docker", "image", "inspect", reference]).stdout
    value = json.loads(output)
    require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict), "image inspect shape is invalid")
    return value[0]


def download_digest(url: str) -> tuple[str, int]:
    request = Request(url, headers={"User-Agent": "Team-AI-Box-release-minimum/1"})
    hasher = hashlib.sha256()
    size = 0
    with urlopen(request, timeout=60) as response:
        while chunk := response.read(1024 * 1024):
            hasher.update(chunk)
            size += len(chunk)
    return "sha256:" + hasher.hexdigest(), size


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--image", default=IMAGE)
    args = parser.parse_args(argv)
    require(RUN_ID.fullmatch(args.run_id) is not None, "run ID is invalid")
    evidence_path = EVIDENCE_ROOT / f"{args.run_id}.json"
    artifact_root = EVIDENCE_ROOT / args.run_id
    require(not evidence_path.exists() and not artifact_root.exists(), "run identity already has evidence")
    artifact_root.mkdir(parents=True)
    started_at = now()
    phase = "preflight"
    evidence: dict[str, Any] = {}
    signing_key = artifact_root / "release.key"
    signing_env = artifact_root / "cosign.env"
    try:
        phase = "review"
        review_summary = validate_review(REVIEW)
        require(review_summary["allRequiredHumanDecisionsApproved"] is True, "human decisions are not approved")
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
        require(lock.get("schemaVersion") == 2 and lock.get("lockId") == "teamaibox.airplay-compatible-stack.open-source.v2", "release lock identity drifted")
        sources = [{"path": relative, "sha256": file_digest(ROOT / relative)} for relative in SOURCE_PATHS]

        phase = "direct_source_verification"
        receiver = lock["receiver"]
        browser = lock["separateBrowserDelivery"]
        downloads = []
        for name, url, expected in (
            ("uxplay", receiver["archiveUrl"], receiver["archiveSha256"]),
            ("livekit-server", browser["sfuSource"]["archiveUrl"], browser["sfuSource"]["archiveSha256"]),
            ("livekit-client", browser["browserPackageTarball"], browser["browserPackageTarballSha256"]),
        ):
            observed, size = download_digest(url)
            require(observed == expected, f"direct source digest drifted: {name}")
            downloads.append({"name": name, "url": url, "sha256": observed, "bytes": size, "verified": True})

        phase = "image_inspection"
        image = inspect_image(args.image)
        image_id = image.get("Id")
        config = image.get("Config", {})
        require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is not None, "image digest is invalid")
        require(image.get("Architecture") == "arm64" and image.get("Os") == "linux", "image platform is not ARM64 Linux")
        require(config.get("User") == "65532:65532", "image runtime user is not the approved non-root identity")
        require(config.get("Labels", {}).get("org.opencontainers.image.revision") == receiver["commitSha1"], "image revision label drifted")
        package_script = "set -eu; dpkg-query -W -f='${Package}=${Version}\\n' dbus gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-tools libavahi-compat-libdnssd1 libplist-2.0-4; test -z \"$(ldd /usr/bin/uxplay | grep 'not found' || true)\"; uxplay -h >/tmp/help 2>&1; grep -q 'UxPlay 1.73.6' /tmp/help; for p in h264parse avdec_h264 avdec_aac avdec_alac webrtcbin vp8enc opusenc; do gst-inspect-1.0 \"$p\" >/dev/null; done"
        smoke = command(["docker", "run", "--rm", "--platform", "linux/arm64/v8", "--entrypoint", "/bin/sh", args.image, "-ec", package_script])
        observed_packages = sorted(line for line in smoke.stdout.decode().splitlines() if "=" in line)
        expected_packages = sorted(f"{name}={version}" for name, version in lock["directRuntimePackages"].items())
        require(observed_packages == expected_packages, "direct runtime package revisions drifted")

        tools = lock["verificationTools"]
        for tool_name, tool_image in tools.items():
            tool = inspect_image(tool_image)
            require(tool.get("Architecture") == "arm64" and tool.get("Os") == "linux", f"{tool_name} tool platform drifted")

        phase = "spdx"
        sbom_path = artifact_root / "trusted-media-service.spdx.json"
        sbom_result = docker_tool(tools["syft"], ["scan", "docker:" + args.image, "--output", "spdx-json"], docker_socket=True, timeout=900)
        sbom_path.write_bytes(sbom_result.stdout)
        sbom = json.loads(sbom_result.stdout)
        require(str(sbom.get("spdxVersion", "")).startswith("SPDX-") and len(sbom.get("packages", [])) > 0, "SPDX SBOM is invalid")

        phase = "vulnerability_scan"
        vulnerability_path = artifact_root / "trusted-media-service.grype.json"
        scan_result = docker_tool(
            tools["grype"],
            ["sbom:/work/" + sbom_path.name, "--output", "json", "--quiet"],
            work=artifact_root,
            timeout=1800,
        )
        vulnerability_path.write_bytes(scan_result.stdout)
        scan = json.loads(scan_result.stdout)
        matches = scan.get("matches", [])
        require(isinstance(matches, list), "Grype report is invalid")
        critical = [item for item in matches if str(item.get("vulnerability", {}).get("severity", "")).lower() == "critical"]
        require(len(critical) == 0, f"final image has {len(critical)} unaccepted Critical vulnerabilities")

        phase = "signature"
        subject_path = artifact_root / "image-signing-subject.json"
        subject = {
            "schemaVersion": 1,
            "subject": "teamaibox.trusted-media-service.open-source.v2",
            "architecture": "linux/arm64/v8",
            "imageContentDigest": image_id,
            "sourceLockDigest": file_digest(LOCK),
            "dockerfileDigest": file_digest(ROOT / "deploy/casting/TrustedMediaService.arm64.v2.Dockerfile"),
            "spdxDigest": file_digest(sbom_path),
            "vulnerabilityReportDigest": file_digest(vulnerability_path),
        }
        write_json(subject_path, subject)
        signing_env.write_text("COSIGN_PASSWORD=" + secrets.token_urlsafe(48) + "\n", encoding="utf-8")
        signing_env.chmod(0o600)
        docker_tool(tools["cosign"], ["generate-key-pair", "--output-key-prefix", "/work/release"], work=artifact_root, env_file=signing_env)
        signature_path = artifact_root / "image-signature.sig"
        docker_tool(tools["cosign"], ["sign-blob", "--yes", "--tlog-upload=false", "--use-signing-config=false", "--key", "/work/release.key", "--output-signature", "/work/image-signature.sig", "/work/image-signing-subject.json"], work=artifact_root, env_file=signing_env)
        verification = docker_tool(tools["cosign"], ["verify-blob", "--insecure-ignore-tlog", "--key", "/work/release.pub", "--signature", "/work/image-signature.sig", "/work/image-signing-subject.json"], work=artifact_root)
        require(b"Verified OK" in verification.stdout or b"Verified OK" in verification.stderr, "Cosign verification did not pass")
        signing_key.unlink(missing_ok=True)
        signing_env.unlink(missing_ok=True)

        evidence = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.airplay-open-source-release-minimum.v1",
            "runId": args.run_id,
            "status": "passed",
            "startedAt": started_at,
            "finishedAt": now(),
            "sources": sources,
            "review": {"path": str(REVIEW.relative_to(ROOT)), "sha256": file_digest(REVIEW), **review_summary},
            "directSources": downloads,
            "image": {
                "reference": args.image,
                "contentDigest": image_id,
                "architecture": "arm64",
                "os": "linux",
                "runtimeUser": config["User"],
                "receiverVersion": "1.73.6",
                "receiverRevision": receiver["commitSha1"],
                "observedDirectPackages": observed_packages,
                "dynamicLinksComplete": True,
                "requiredMediaElementsPresent": True,
                "nonRoot": True,
            },
            "spdx": {"path": f"{args.run_id}/{sbom_path.name}", "sha256": file_digest(sbom_path), "format": sbom["spdxVersion"], "packageCount": len(sbom["packages"]), "verified": True},
            "vulnerabilities": {"path": f"{args.run_id}/{vulnerability_path.name}", "sha256": file_digest(vulnerability_path), "matchCount": len(matches), "criticalCount": 0, "acceptedCriticalCount": 0, "unacceptedCriticalCount": 0, "accepted": True},
            "signature": {
                "subjectPath": f"{args.run_id}/{subject_path.name}",
                "subjectSha256": file_digest(subject_path),
                "signaturePath": f"{args.run_id}/{signature_path.name}",
                "signatureSha256": file_digest(signature_path),
                "publicKeyPath": f"{args.run_id}/release.pub",
                "publicKeySha256": file_digest(artifact_root / "release.pub"),
                "tool": tools["cosign"],
                "verified": True,
                "privateKeyRetained": False,
            },
            "optionalAssurance": {"privateMirror": False, "airplaySpecificSlsa": False, "cycloneDx": False, "secondIndependentBuild": False, "required": False},
            "executionBoundary": {"imageBuiltLocally": True, "remoteDeploymentPerformed": False, "receiverStarted": False, "receiverAdvertised": False, "mediaProcessed": False},
            "claimBoundary": {"openSourceReleaseMinimumComplete": True, "task22_1Complete": True, "task22_3Complete": False, "productAccepted": False, "releaseEligibleForDeployment": True, "receiverActivationAuthorized": False},
        }
    except Exception as error:
        signing_key.unlink(missing_ok=True)
        signing_env.unlink(missing_ok=True)
        evidence = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.airplay-open-source-release-minimum.v1",
            "runId": args.run_id,
            "status": "failed",
            "startedAt": started_at,
            "finishedAt": now(),
            "failure": {"phase": phase, "type": type(error).__name__, "message": str(error)[-2000:]},
            "claimBoundary": {"openSourceReleaseMinimumComplete": False, "task22_1Complete": False, "task22_3Complete": False, "productAccepted": False, "releaseEligibleForDeployment": False, "receiverActivationAuthorized": False},
        }
    evidence["evidenceDigest"] = canonical_digest(evidence)
    write_json(evidence_path, evidence)
    print(json.dumps({"runId": args.run_id, "status": evidence["status"], "phase": phase, "evidence": str(evidence_path.relative_to(ROOT)), "evidenceDigest": evidence["evidenceDigest"]}, sort_keys=True))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
