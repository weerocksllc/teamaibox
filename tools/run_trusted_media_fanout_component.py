"""Bounded private, CPU-only eight-viewer synthetic transport validation."""
import os
import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MEDIA_IMAGE = os.environ.get('TEAMAIBOX_RUN_TRUSTED_MEDIA_FANOUT_COMPONENT_MEDIA_IMAGE')
SFU_IMAGE = "docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a"
SOURCES = ("tools/run_trusted_media_fanout_component.py", "tools/validate_trusted_media_fanout_component.py",
    "services/trusted_media_runtime/sfu_gateway.py", "services/trusted_media_runtime/main.py",
    "tests/test_trusted_media_sfu_gateway.py",
    "tests/test_trusted_media_fanout_real_media.py", "tests/test_trusted_media_webrtc_real_media.py",
    "services/trusted_media_service/webrtc_media_output.py", "services/trusted_media_service/gdp_media_ingress.py",
    "services/trusted_media_service/publisher_credentials.py", "services/trusted_media_service/viewer_token_issuer.py",
    "services/trusted_media_service/livekit_browser_sink.py", "services/trusted_media_service/livekit_room_control.py",
    "services/trusted_media_service/callback_client.py", "services/trusted_media_service/tls_runtime_server.py",
    "services/trusted_media_service/runtime_api.py")


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def inspect(kind, identity):
    response = subprocess.run(["docker", kind, "inspect", identity], capture_output=True, timeout=15)
    return json.loads(response.stdout)[0] if response.returncode == 0 else None


def run(run_id):
    if MEDIA_IMAGE is None:
        raise ValueError('explicit_TEAMAIBOX_RUN_TRUSTED_MEDIA_FANOUT_COMPONENT_MEDIA_IMAGE_required')
    if not re.fullmatch(r"casting-fanout-component-20[0-9]{6}-a[1-9][0-9]*", run_id):
        raise ValueError("bounded run identity required")
    path = ROOT / "evidence/validation/components" / (run_id + ".json")
    if path.exists():
        raise ValueError("immutable run already exists")
    media = inspect("image", MEDIA_IMAGE)
    if media is None or media["Id"] != MEDIA_IMAGE or media["Architecture"] != "arm64":
        raise ValueError("exact ARM64 component image required")
    with (ROOT / "tmp" / (run_id + ".claim")).open("x") as claim:
        claim.write(run_id + "\n")
    names = {role: "teamaibox-" + role + "-" + run_id for role in ("sfu", "media", "network")}
    for role in ("sfu", "media"):
        if inspect("container", names[role]) is not None:
            raise ValueError("run resource already exists")
    if inspect("network", names["network"]) is not None:
        raise ValueError("run network already exists")
    sources = [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in SOURCES]
    report = {"schemaVersion": 1, "runId": run_id, "status": "failed", "startedAt": utc(), "sources": sources,
        "scope": "isolated eight-GStreamer-viewer synthetic media component", "mediaImageId": MEDIA_IMAGE,
        "sfuImage": SFU_IMAGE, "productAccepted": False, "browserAccepted": False,
        "appleSenderAccepted": False, "hdmiAccepted": False, "receiverAdvertised": False,
        "gpuUsed": False, "hostPortsPublished": False, "cleanupConfirmed": False}
    sfu = None
    owned_network = None
    try:
        subprocess.run(["docker", "network", "create", "--internal", "--label", "org.teamaibox.run=" + run_id,
            names["network"]], check=True, stdout=subprocess.DEVNULL, timeout=20)
        owned_network = inspect("network", names["network"])
        if not owned_network["Internal"]:
            raise RuntimeError("private network required")
        address = str(ipaddress.ip_network(owned_network["IPAM"]["Config"][0]["Subnet"]).network_address + 2)
        config = ("port: 7880\nbind_addresses: [127.0.0.1]\nkeys:\n"
            "  room-test-key: synthetic-only-not-a-deployment-livekit-secret\nrtc:\n  node_ip: " + address +
            "\n  use_external_ip: false\n  tcp_port: 7881\n  udp_port: 7882\nlogging:\n  level: error\n").encode()
        sfu = subprocess.Popen(["docker", "run", "--rm", "-i", "--name", names["sfu"], "--network", names["network"],
            "--ip", address, "--label", "org.teamaibox.run=" + run_id, "--read-only", "--user", "65532:65532",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--memory-swap", "512m",
            "--cpus", "2", "--pids-limit", "128", "--log-driver", "none", SFU_IMAGE, "--config", "/dev/stdin"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sfu.stdin.write(config)
        sfu.stdin.close()
        import time
        for _ in range(40):
            info = inspect("container", names["sfu"])
            if info and info["State"]["Running"]:
                break
            if sfu.poll() is not None:
                raise RuntimeError("sfu startup failed")
            time.sleep(0.1)
        if not info or not info["State"]["Running"]:
            raise RuntimeError("sfu startup timed out")
        report["sfuContainerId"] = info["Id"]
        response = subprocess.run(["docker", "run", "--rm", "--name", names["media"],
            "--label", "org.teamaibox.run=" + run_id, "--network", "container:" + names["sfu"], "--read-only",
            "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "3g", "--memory-swap", "3g", "--cpus", "4", "--pids-limit", "512", "--log-driver", "none",
            "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777", "--env", "HOME=/tmp",
            "--env", "GST_REGISTRY=/tmp/gst-registry.bin", "--env", "GST_DEBUG=0", "--env", "RUST_LOG=off",
            "--env", "TEAMAIBOX_TEST_REAL_MEDIA=1",
            "--mount", "type=bind,src=" + str(ROOT / "services") + ",dst=/workspace/services,readonly",
            "--mount", "type=bind,src=" + str(ROOT / "tests") + ",dst=/workspace/tests,readonly",
            "--workdir", "/workspace", "--entrypoint", "python3", MEDIA_IMAGE, "-m", "unittest", "-v",
            "tests.test_trusted_media_fanout_real_media"], capture_output=True, text=True, timeout=100)
        diagnostic = response.stdout + response.stderr
        diagnostic = diagnostic.replace("synthetic-only-not-a-deployment-livekit-secret", "[secret]")
        diagnostic = re.sub(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[token]", diagnostic)
        diagnostic = re.sub(r"(?:https?|wss?)://[^\s]+", "[endpoint]", diagnostic)
        print(diagnostic[:7000], flush=True)
        report["returnCode"] = response.returncode
        match = re.search(r'(\{"realViewerCount"[^\n]+\})', response.stdout)
        if response.returncode == 0 and match:
            report["facts"] = json.loads(match.group(1))
            if any(digest((ROOT / item["path"]).read_bytes()) != item["sha256"] for item in sources):
                raise RuntimeError("source changed during run")
            report["status"] = "passed"
        else:
            report["diagnostic"] = diagnostic[:7000]
    except Exception as error:
        report["errorClass"] = type(error).__name__
    finally:
        cleanup = True
        for role in ("media", "sfu"):
            info = inspect("container", names[role])
            if info is not None:
                if info["Config"].get("Labels", {}).get("org.teamaibox.run") != run_id:
                    cleanup = False
                    continue
                subprocess.run(["docker", "stop", "--time", "3", info["Id"]],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            cleanup &= inspect("container", names[role]) is None
        if sfu:
            sfu.wait(timeout=10)
        if owned_network:
            actual = inspect("network", names["network"])
            if actual and actual["Id"] == owned_network["Id"] and not actual["Containers"]:
                subprocess.run(["docker", "network", "rm", actual["Id"]], check=True, stdout=subprocess.DEVNULL, timeout=15)
            cleanup &= inspect("network", names["network"]) is None
        report["cleanupConfirmed"] = cleanup
        if not cleanup:
            report["status"] = "failed"
        report["completedAt"] = utc()
        report["evidenceDigest"] = digest(canonical(report))
        with path.open("x") as output:
            json.dump(report, output, ensure_ascii=False, sort_keys=True, indent=2)
        print(json.dumps({key: report[key] for key in ("runId", "status", "evidenceDigest", "cleanupConfirmed")}), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    raise SystemExit(run(parser.parse_args().run_id))
