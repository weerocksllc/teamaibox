"""Actual native DNS-SD on an isolated Docker network, never the user's LAN."""
import argparse
import json
from pathlib import Path
import re
import subprocess

from run_trusted_media_fanout_component import ROOT, digest, canonical, utc, inspect

IMAGE = "teamaibox/trusted-media-service:lifetime-fix-20260908-a1"
SOURCES = ("tools/run_trusted_media_discovery_component.py", "tools/validate_trusted_media_discovery_component.py",
    "deploy/casting/TrustedMediaDiscovery.arm64.Dockerfile", "tests/test_trusted_media_private_discovery.py",
    "services/trusted_media_service/private_discovery.py", "services/trusted_media_service/private_discovery_address.py",
    "deploy/casting/TrustedMediaDiscoveryFix.arm64.Dockerfile",
    "deploy/casting/TrustedMediaDiscoveryFix.arm64.Dockerfile.dockerignore", "services/trusted_media_service/discovery_exec.py",
    "services/trusted_media_service/discoverable_receiver.py", "services/trusted_media_service/native_receiver_process.py",
    "services/trusted_media_service/native_receiver_exec.py", "services/trusted_media_service/native_pairing_bridge.py",
    "services/trusted_media_service/service_child_process.py", "services/trusted_media_service/runtime_api.py",
    "tests/test_trusted_media_service_child_process.py", "tests/test_trusted_media_runtime_api.py",
    "deploy/casting/TrustedMediaLifetimeFix.arm64.Dockerfile",
    "deploy/casting/TrustedMediaLifetimeFix.arm64.Dockerfile.dockerignore")


def run(run_id):
    if not re.fullmatch(r"casting-private-discovery-20[0-9]{6}-a[1-9][0-9]*", run_id):
        raise ValueError("bounded run required")
    path = ROOT / "evidence/validation/components" / (run_id + ".json")
    if path.exists(): raise ValueError("immutable evidence exists")
    image = inspect("image", IMAGE)
    if not image or image["Architecture"] != "arm64" or image["Config"]["User"] != "65532:65532":
        raise ValueError("built ARM64 image required")
    name, net = "teamaibox-" + run_id, "teamaibox-net-" + run_id
    if inspect("container", name) or inspect("network", net): raise ValueError("run already occupied")
    with (ROOT / "tmp" / (run_id + ".claim")).open("x") as output: output.write(run_id)
    report = {"schemaVersion": 1, "runId": run_id, "status": "failed", "startedAt": utc(),
        "imageId": image["Id"], "architecture": image["Architecture"],
        "sources": [{"path": p, "sha256": digest((ROOT / p).read_bytes())} for p in SOURCES],
        "userLanAdvertised": False, "hostPortsPublished": False, "gpuUsed": False,
        "hostBusMounted": False, "productAccepted": False, "appleSenderAccepted": False,
        "scope": "private Docker DNS-SD native receiver component", "cleanupConfirmed": False}
    owned_network = None
    try:
        subprocess.run(["docker", "network", "create", "--internal", "--label", "org.teamaibox.run=" + run_id, net],
            check=True, stdout=subprocess.DEVNULL, timeout=20)
        owned_network = inspect("network", net)
        if not owned_network["Internal"]: raise ValueError("internal network required")
        command = ["docker", "run", "--name", name, "--label", "org.teamaibox.run=" + run_id,
            "--network", net, "--read-only", "--no-healthcheck", "--user", "65532:65532",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128",
            "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--log-driver", "none",
            "--tmpfs", "/run/teamaibox:rw,noexec,nosuid,nodev,size=8m,uid=65532,gid=65532,mode=0700",
            "--tmpfs", "/run/avahi-daemon:rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0700",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777", "--env", "TEAMAIBOX_TEST_PRIVATE_DISCOVERY=1",
            "--mount", "type=bind,src=" + str(ROOT / "services") + ",dst=/workspace/services,readonly",
            "--mount", "type=bind,src=" + str(ROOT / "tests") + ",dst=/workspace/tests,readonly",
            "--workdir", "/workspace", "--entrypoint", "python3", image["Id"], "-m", "unittest", "-v",
            "tests.test_trusted_media_private_discovery", "tests.test_trusted_media_service_child_process",
            "tests.test_trusted_media_runtime_api"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=50)
        info = inspect("container", name)
        report["returnCode"] = result.returncode
        report["containerPolicy"] = {"imageId": info["Image"], "readOnly": info["HostConfig"]["ReadonlyRootfs"],
            "capDrop": info["HostConfig"]["CapDrop"], "user": info["Config"]["User"],
            "networkInternal": owned_network["Internal"], "publishedPorts": info["HostConfig"]["PortBindings"],
            "deviceRequests": info["HostConfig"]["DeviceRequests"], "oomKilled": info["State"]["OOMKilled"]}
        # Only dedicated synthetic names/PIN in this run, but never persist
        # private daemon output. Tests emit stable facts and class-level errors.
        diagnostic = (result.stdout + result.stderr).replace("9876", "[test-pin]")[:6000]
        report["diagnostic"] = diagnostic
        print(diagnostic, flush=True)
        match = re.search(r'(\{"privateDnsSdObserved"[^\n]+\})', result.stdout)
        if result.returncode == 0 and match:
            report["facts"] = json.loads(match.group(1))
            guard = re.search(r'(\{"serviceParentDeathProtectionObserved"[^\n]+\})', result.stdout)
            if not guard or json.loads(guard.group(1)) != {"serviceParentDeathProtectionObserved": True}:
                raise ValueError("service parent death check missing")
            report["facts"].update(json.loads(guard.group(1)))
            if any(digest((ROOT / s["path"]).read_bytes()) != s["sha256"] for s in report["sources"]):
                raise ValueError("source drift during run")
            report["status"] = "passed"
    except Exception as error:
        report["errorClass"] = type(error).__name__
    finally:
        info = inspect("container", name)
        cleanup = True
        if info:
            if info["Image"] == image["Id"] and info["Config"].get("Labels", {}).get("org.teamaibox.run") == run_id:
                subprocess.run(["docker", "rm", "-f", info["Id"]], check=True, stdout=subprocess.DEVNULL, timeout=15)
            else: cleanup = False
        cleanup &= inspect("container", name) is None
        current = inspect("network", net)
        if current and owned_network and current["Id"] == owned_network["Id"] and not current["Containers"]:
            subprocess.run(["docker", "network", "rm", current["Id"]], check=True, stdout=subprocess.DEVNULL, timeout=15)
        cleanup &= inspect("network", net) is None
        report["cleanupConfirmed"] = cleanup
        if not cleanup: report["status"] = "failed"
        report["completedAt"] = utc()
        report["evidenceDigest"] = digest(canonical(report))
        with path.open("x") as output: json.dump(report, output, indent=2, sort_keys=True)
        print(json.dumps({k: report[k] for k in ("runId", "status", "evidenceDigest", "cleanupConfirmed")}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    raise SystemExit(run(parser.parse_args().run_id))
