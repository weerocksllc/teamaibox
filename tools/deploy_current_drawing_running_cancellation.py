#!/usr/bin/env python3
"""Incrementally deploy confirmed running cancellation for external Drawing."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from typing import Any

try:
    from .deploy_current_provider_contract_lifecycle import (
        CANONICAL_WEB, COMPOSE_FILES, CURRENT, EDGE_NETWORK, PLATFORM, PROJECT, REMOTE,
        ROOT, RUNTIME, RUNTIME_KEY, STANDARD_WEB, DeploymentError, command, compose,
        digest, environment, inspect, source, wait_healthy, write_evidence,
    )
    from .run_spark_model_baseline import canonical_digest, utc_now
except ImportError:
    from deploy_current_provider_contract_lifecycle import (
        CANONICAL_WEB, COMPOSE_FILES, CURRENT, EDGE_NETWORK, PLATFORM, PROJECT, REMOTE,
        ROOT, RUNTIME, RUNTIME_KEY, STANDARD_WEB, DeploymentError, command, compose,
        digest, environment, inspect, source, wait_healthy, write_evidence,
    )
    from run_spark_model_baseline import canonical_digest, utc_now


RUN_ID = re.compile(r"^current-drawing-running-cancellation-[0-9]{8}-a[1-9][0-9]*$")
PARENT_RUN_ID = re.compile(r"^current-provider-contract-lifecycle-[0-9]{8}-a[1-9][0-9]*$")
DOCKERFILE = "deploy/application-catalog-e2e/PlatformApiDrawingCancellation.Dockerfile"
BRIDGE = "apps/platform-api/src/compute/openai-worker-execution-bridge.mjs"
SOURCES = (
    BRIDGE,
    "apps/platform-api/test/openai-worker-execution-bridge.test.mjs",
    DOCKERFILE,
    "tools/deploy_current_provider_contract_lifecycle.py",
    "tools/deploy_current_drawing_running_cancellation.py",
    "tools/validate_current_drawing_running_cancellation.py",
)


def require(value: bool, message: str) -> None:
    if not value:
        raise DeploymentError(message)


def validate_parent(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    require(resolved.is_file() and resolved.is_relative_to(ROOT / "evidence/validation/feature-deployments"), "Drawing cancellation parent is unscoped")
    checked = subprocess.run(
        ["python3", "tools/validate_current_provider_contract_lifecycle.py", "--evidence", str(resolved)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=480, check=False,
    )
    require(checked.returncode == 0 and json.loads(checked.stdout).get("valid") is True,
            "Drawing cancellation parent failed strict live validation")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(PARENT_RUN_ID.fullmatch(str(value.get("runId", ""))) is not None
            and value.get("runnerId") == "teamaibox.current-provider-contract-lifecycle-deployment.v1"
            and value.get("status") == "passed" and value.get("failure") is None,
            "Drawing cancellation parent identity drifted")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--parent-evidence", type=Path, required=True)
    args = parser.parse_args()
    require(RUN_ID.fullmatch(args.run_id) is not None, "unsafe Drawing cancellation deployment identity")
    output = ROOT / "evidence/validation/feature-deployments" / f"{args.run_id}.json"
    require(not output.exists(), "immutable Drawing cancellation deployment evidence exists")
    parent_path = args.parent_evidence.resolve()
    parent = validate_parent(parent_path)
    paths = [ROOT / relative for relative in SOURCES]
    for path in paths:
        require(path.is_file(), "missing Drawing cancellation source: " + path.relative_to(ROOT).as_posix())
    tested = subprocess.run(
        ["node", "--test", "apps/platform-api/test/openai-worker-execution-bridge.test.mjs"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180, check=False,
    )
    require(tested.returncode == 0, "Drawing cancellation source tests failed")
    count = re.search(rb"(?:#|\xe2\x84\xb9) tests ([0-9]+)", tested.stdout)
    require(count is not None, "Drawing cancellation test count is unavailable")

    run_root = "/var/lib/teamaibox-feature-deployments/" + args.run_id
    tag = "teamaibox/platform-api:" + args.run_id
    base_tag = tag + "-base"
    parent_image = parent["images"]["candidateImageId"]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.current-drawing-running-cancellation-deployment.v1",
        "runId": args.run_id,
        "status": "failed",
        "startedAt": utc_now(),
        "completedAt": None,
        "target": "dgx-spark-dev-01",
        "project": PROJECT,
        "runRoot": run_root,
        "parent": {"path": parent_path.relative_to(ROOT).as_posix(), "digest": digest(parent_path),
                   "runId": parent["runId"], "evidenceDigest": parent["evidenceDigest"], "platformImageId": parent_image},
        "sources": [source(path) for path in paths],
        "sourceTests": {"passed": True, "count": int(count.group(1)), "outputRetained": False},
        "images": None,
        "runtime": None,
        "cleanup": None,
        "failure": None,
        "componentReady": False,
        "productAccepted": False,
        "blockers": ["real running Drawing cancellation acceptance", "model quality certification", "independent human acceptance"],
    }
    previous = None
    changed = False
    switched = False
    try:
        require(REMOTE.run(("test", "!", "-e", run_root), 15).returncode == 0, "remote Drawing cancellation run root exists")
        previous = inspect(PLATFORM)
        require(previous["Image"] == parent_image and previous["State"].get("Health", {}).get("Status") == "healthy",
                "live Platform does not match Drawing cancellation parent")
        command(("sudo", "mkdir", "-p", run_root + "/source", run_root + "/before/apps/platform-api/src/compute"), "create Drawing cancellation run root", 30)
        command(("sudo", "chown", "-R", "d:d", run_root), "own Drawing cancellation run root", 30)
        with tempfile.TemporaryDirectory(prefix="teamaibox-drawing-cancel-") as directory:
            archive = Path(directory) / "source.tar.gz"
            with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
                for path in paths:
                    bundle.add(path, arcname=path.relative_to(ROOT).as_posix(), recursive=False)
            require(REMOTE.copy(archive, run_root + "/source.tar.gz", 120).returncode == 0, "Drawing cancellation source transfer failed")
        command(("tar", "-xzf", run_root + "/source.tar.gz", "-C", run_root + "/source"), "extract Drawing cancellation sources", 60)
        command(("rm", "--", run_root + "/source.tar.gz"), "remove Drawing cancellation source archive", 15)
        command(("sudo", "docker", "tag", parent_image, base_tag), "tag exact Drawing cancellation parent", 30)
        command(("sudo", "docker", "build", "--no-cache", "--network", "none", "-f", run_root + "/source/" + DOCKERFILE,
                 "--build-arg", "BASE_IMAGE=" + base_tag, "-t", tag, run_root + "/source"), "build Drawing cancellation Platform", 300)
        image = json.loads(command(("sudo", "docker", "image", "inspect", tag), "inspect Drawing cancellation image", 30))[0]
        require(image.get("Architecture") == "arm64" and image["Id"] != parent_image, "Drawing cancellation image is invalid")
        report["images"] = {"parentImageId": parent_image, "candidateImageId": image["Id"], "tag": tag,
                            "architecture": image["Architecture"], "sizeBytes": image["Size"]}
        command(("sudo", "cp", "--", RUNTIME, run_root + "/before/runtime.env"), "backup runtime", 30)
        persistent = CURRENT + "/source/" + BRIDGE
        command(("sudo", "cp", "--", persistent, run_root + "/before/" + BRIDGE), "backup Drawing execution bridge", 30)
        original_runtime = command(("sudo", "cat", RUNTIME), "read runtime", 30)
        with tempfile.TemporaryDirectory(prefix="teamaibox-drawing-cancel-runtime-") as directory:
            candidate = Path(directory) / "runtime.env"
            candidate.write_text(environment(original_runtime, RUNTIME_KEY, image["Id"]), encoding="utf-8")
            require(REMOTE.copy(candidate, run_root + "/runtime.env.candidate", 60).returncode == 0, "Drawing cancellation runtime transfer failed")
        command(("sudo", "install", "-o", "d", "-g", "d", "-m", "0600", run_root + "/runtime.env.candidate", RUNTIME), "pin Drawing cancellation image", 30)
        command(("sudo", "install", "-D", "-o", "d", "-g", "d", "-m", "0644", run_root + "/source/" + BRIDGE, persistent), "install Drawing execution bridge", 30)
        changed = True
        compose(("up", "-d", "--no-deps", "--force-recreate", "platform-api"), 240)
        current = wait_healthy(PLATFORM)
        switched = True
        require(current["Image"] == image["Id"], "Drawing cancellation Platform was not activated")
        command(("sudo", "docker", "network", "disconnect", EDGE_NETWORK, PLATFORM), "detach Drawing cancellation Platform from edge", 30)
        command(("sudo", "docker", "network", "connect", "--alias", "platform-api", "--alias", "platform-api-443", EDGE_NETWORK, PLATFORM), "restore Drawing cancellation Platform edge aliases", 30)
        current = wait_healthy(PLATFORM)
        command(("sudo", "docker", "restart", CANONICAL_WEB, STANDARD_WEB), "refresh Web upstream resolution", 90)
        canonical_web = wait_healthy(CANONICAL_WEB)
        standard_web = wait_healthy(STANDARD_WEB)
        internal = int(command(("sudo", "docker", "exec", PLATFORM, "node", "-e",
                                "fetch('http://127.0.0.1:8080/health/ready').then(r=>console.log(r.status))"), "probe Drawing cancellation Platform", 30).strip())
        ready = int(command(("curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", "https://127.0.0.1/health/ready"), "probe Drawing cancellation HTTPS", 30).strip())
        require((internal, ready) == (200, 200), "Drawing cancellation Platform ingress failed")
        report["runtime"] = {"container": PLATFORM, "previousContainerId": previous["Id"], "containerId": current["Id"],
                             "imageId": current["Image"], "healthy": True, "internalReadyStatus": internal,
                             "httpsReadyStatus": ready, "trustClaimed": False,
                             "web": {"canonicalContainerId": canonical_web["Id"], "standardContainerId": standard_web["Id"]}}
        report["componentReady"] = True
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error)[-1200:]}
        cleanup = {"runtimeRestored": not changed, "sourceRestored": not changed, "platformRolledBack": not switched,
                   "candidateRemoved": False, "runRootRemoved": False}
        if changed and previous is not None:
            try:
                command(("sudo", "cp", "--", run_root + "/before/runtime.env", RUNTIME), "restore runtime", 30)
                command(("sudo", "cp", "--", run_root + "/before/" + BRIDGE, CURRENT + "/source/" + BRIDGE), "restore Drawing bridge", 30)
                cleanup["runtimeRestored"] = cleanup["sourceRestored"] = True
                compose(("up", "-d", "--no-deps", "--force-recreate", "platform-api"), 240)
                cleanup["platformRolledBack"] = wait_healthy(PLATFORM)["Image"] == previous["Image"]
            except Exception as rollback_error:
                report["failure"]["rollback"] = str(rollback_error)[-800:]
        try:
            REMOTE.run(("sudo", "docker", "image", "rm", tag, base_tag), 60)
            cleanup["candidateRemoved"] = True
            command(("sudo", "rm", "-r", "--", run_root), "remove failed Drawing cancellation run root", 30)
            cleanup["runRootRemoved"] = True
        except Exception:
            pass
        report["cleanup"] = cleanup
    finally:
        REMOTE.run(("sudo", "docker", "image", "rm", base_tag), 30)
        report["completedAt"] = utc_now()
        report["evidenceDigest"] = canonical_digest(report)
        write_evidence(output, report)
    print(json.dumps({"runId": args.run_id, "status": report["status"], "evidence": output.relative_to(ROOT).as_posix(),
                      "evidenceDigest": report["evidenceDigest"], "failure": report["failure"]}, ensure_ascii=False, separators=(",", ":")))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DeploymentError, OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(f"Current Drawing cancellation deployment failed: {error}")
        raise SystemExit(1)
