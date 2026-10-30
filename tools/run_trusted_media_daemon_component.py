"""Bounded main-box private-daemon check; no receiver/media/host-device access."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess

from run_trusted_media_hdmi_component import ROOT, canonical, digest, inspect, ssh, utc


IMAGE = "sha256:1ed9851b1e8aac608503c62743d6370dfa0928b4031d323b91f8b87c8def9f8d"
TAG = "teamaibox/trusted-media-service:private-daemon-20260907-a1"
LOCAL_IMAGE = "sha256:a726b77d43d0f90d2be96defed061b92a04b31824c5080b67d8bc548419acb66"
WORKERS = tuple("teamaibox-worker-" + value for value in (
    "45dece00-515c-5658-b903-e7b68689cebb", "50ed0d01-9b60-5ec3-a840-d8f56127c53e",
    "c2e3e722-08da-5141-89f5-b8244deb817f", "b3ea0138-4acf-5840-ad1d-5b698cc89cf5",
    "7f97d6a6-d63c-5383-8cf8-a93841437494", "4ac86c89-ef71-5fe5-8a6a-0e8979fff66d"))
MODULES = tuple(sorted(str(path.relative_to(ROOT)) for package in ("trusted_media_service", "trusted_media_runtime")
    for path in (ROOT / "services" / package).rglob("*.py")))
SOURCES = MODULES + ("tools/probe_trusted_media_daemon.py", "tools/run_trusted_media_daemon_component.py",
    "tests/test_trusted_media_daemon.py", "deploy/casting/TrustedMediaDaemon.arm64.Dockerfile",
    "deploy/casting/TrustedMediaDaemon.arm64.Dockerfile.dockerignore")


def workers():
    rows = []
    for name in WORKERS:
        value = inspect("container", name)
        if not value or not value["State"]["Running"] or value["State"].get("Health", {}).get("Status") != "healthy":
            raise ValueError("protected office Worker not healthy")
        rows.append({"name": name, "containerId": value["Id"], "imageId": value["Image"], "healthy": True})
    return rows


def run(run_id):
    if not re.fullmatch(r"casting-daemon-component-20[0-9]{6}-a[1-9][0-9]*", run_id):
        raise ValueError("bounded identity required")
    path = ROOT / "evidence/validation/components" / (run_id + ".json")
    name = "teamaibox-" + run_id
    claim = ROOT / "tmp" / (run_id + ".claim")
    if path.exists() or claim.exists() or inspect("container", name): raise ValueError("identity already used")
    local = json.loads(subprocess.check_output(["docker", "image", "inspect", TAG]))[0]
    remote = inspect("image", IMAGE)
    if local["Id"] != LOCAL_IMAGE or not remote or remote["Id"] != IMAGE or remote["Architecture"] != "arm64":
        raise ValueError("exact ARM64 image must be transferred first")
    before = workers()
    memory = ssh("awk '/MemAvailable:/{print $2}' /proc/meminfo")
    if memory.returncode != 0 or int(memory.stdout.strip()) * 1024 < 48 * 1024**3 + 256 * 1024**2:
        raise ValueError("core reserve and host margin must remain available")
    display = ssh("systemctl is-active display-manager").stdout.decode().strip()
    with claim.open("x") as output: output.write(run_id)
    report = {"schemaVersion": 1, "runId": run_id, "status": "failed", "startedAt": utc(), "imageId": IMAGE,
        "sources": {source: digest((ROOT / source).read_bytes()) for source in SOURCES}, "workersBefore": before,
        "displayBefore": display, "hostMutations": False, "workerMutations": False, "productAccepted": False,
        "cleanupConfirmed": False}
    container_id = None
    try:
        command = ["docker", "create", "-i", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1",
            "--pids-limit", "64", "--log-driver", "none", "--tmpfs",
            "/run/teamaibox:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m",
            "--entrypoint", "/usr/bin/python3", IMAGE, "-"]
        created = ssh(shlex.join(command))
        if created.returncode != 0: raise RuntimeError("container create failed")
        owned = inspect("container", name)
        container_id = owned["Id"]
        report["containerId"] = container_id
        report["policy"] = policy(owned)
        result = ssh(shlex.join(["docker", "start", "--attach", "--interactive", name]), timeout=90,
                     input=(ROOT / "tools/probe_trusted_media_daemon.py").read_bytes())
        report["returnCode"] = result.returncode
        # The probe emits exactly one bounded aggregate JSON, no diagnostics.
        if len(result.stdout) > 32 * 1024: raise RuntimeError("probe output too large")
        report["probe"] = json.loads(result.stdout)
        ended = inspect("container", name)
        report["exitCode"] = ended["State"]["ExitCode"]
        report["oomKilled"] = ended["State"]["OOMKilled"]
        if result.returncode != 0 or report["probe"]["status"] != "passed": raise RuntimeError("probe failed")
        report["status"] = "passed"
    except Exception as error:
        report["errorCategory"] = type(error).__name__
    finally:
        try:
            current = inspect("container", name)
            # A lost create response is recoverable only after exact image and
            # generated name confirmation; never touch an unrelated container.
            if current:
                if current["Image"] != IMAGE or (container_id is not None and current["Id"] != container_id):
                    raise RuntimeError("owned identity changed")
                removed = ssh(shlex.join(["docker", "rm", "-f", current["Id"]]))
                if removed.returncode != 0: raise RuntimeError("owned cleanup pending")
            report["cleanupConfirmed"] = inspect("container", name) is None
            report["workersAfter"] = workers()
            report["displayAfter"] = ssh("systemctl is-active display-manager").stdout.decode().strip()
            report["sourcesUnchanged"] = report["sources"] == {source: digest((ROOT / source).read_bytes()) for source in SOURCES}
            if report["workersAfter"] != before or report["displayAfter"] != display or not report["sourcesUnchanged"]:
                report["status"] = "failed"
        except Exception:
            report["status"] = "failed"
            report["cleanupConfirmed"] = False
        report["completedAt"] = utc()
        report["evidenceDigest"] = digest(canonical(report))
        with path.open("x") as output: json.dump(report, output, indent=2, sort_keys=True); output.write("\n")
    print(json.dumps({"runId": run_id, "status": report["status"], "cleanupConfirmed": report["cleanupConfirmed"],
                      "evidenceDigest": report["evidenceDigest"]}))
    return report["status"] == "passed"


def policy(value):
    host = value["HostConfig"]
    return {"imageId": value["Image"], "user": value["Config"]["User"], "network": host["NetworkMode"],
        "readOnly": host["ReadonlyRootfs"], "privileged": host["Privileged"], "capDrop": host["CapDrop"],
        "capAdd": host["CapAdd"], "securityOpt": host["SecurityOpt"], "memoryBytes": host["Memory"],
        "swapBytes": host["MemorySwap"], "nanoCpus": host["NanoCpus"], "pidsLimit": host["PidsLimit"],
        "devices": host["Devices"], "deviceRequests": host["DeviceRequests"], "binds": host["Binds"],
        "tmpfs": host["Tmpfs"], "logDriver": host["LogConfig"]["Type"]}


def validate(path):
    value = json.loads(path.read_bytes())
    expected = value.pop("evidenceDigest")
    assert digest(canonical(value)) == expected
    assert path.name == value["runId"] + ".json"
    assert value["status"] == "passed" and value["returnCode"] == value["exitCode"] == 0
    assert value["imageId"] == IMAGE and value["oomKilled"] is False
    assert value["cleanupConfirmed"] is True and value["sourcesUnchanged"] is True
    assert value["sources"] == {source: digest((ROOT / source).read_bytes()) for source in SOURCES}
    assert value["workersBefore"] == value["workersAfter"] == workers()
    assert value["displayBefore"] == value["displayAfter"] == "active"
    assert all(value[key] is False for key in ("hostMutations", "workerMutations", "productAccepted"))
    policy = value["policy"]
    assert policy == {"imageId": IMAGE, "user": "65532:65532", "network": "none", "readOnly": True,
        "privileged": False, "capDrop": ["ALL"], "capAdd": None, "securityOpt": ["no-new-privileges"],
        "memoryBytes": 256 * 1024**2, "swapBytes": 256 * 1024**2, "nanoCpus": 10**9, "pidsLimit": 64,
        "devices": [], "deviceRequests": None, "binds": None,
        "tmpfs": {"/run/teamaibox": "rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m"}, "logDriver": "none"}
    probe = value["probe"]
    assert probe["status"] == "passed" and probe["exitCode"] == 0 and probe["receiverChildrenBeforeStop"] == 0
    for key in ("realTls", "syntheticCredentials", "nonRootWithoutCapabilities", "authenticatedControlPassed", "replayRejected",
                "otherServiceRejected", "unauthenticatedRejected", "listenerClosed", "cleanupConfirmed"):
        assert probe[key] is True
    assert all(probe[key] is False for key in ("productAccepted", "appleSenderAccepted", "receiverAdvertised", "recording", "mediaSessionRequested"))
    assert probe["imageSources"] == {source: digest((ROOT / source).read_bytes()) for source in MODULES}
    assert inspect("container", "teamaibox-" + value["runId"]) is None
    assert inspect("image", IMAGE)["Architecture"] == "arm64"
    print(json.dumps({"runId": value["runId"], "strictValidation": "passed", "productAccepted": False, "evidenceDigest": expected}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-id")
    group.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    if args.evidence: validate(args.evidence)
    else: raise SystemExit(0 if run(args.run_id) else 1)
