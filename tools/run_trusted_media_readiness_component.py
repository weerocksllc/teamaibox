"""Exact ARM64 private-readiness check; no receiver, devices or office mutations."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess

from run_trusted_media_hdmi_component import ROOT, canonical, digest, inspect, ssh, utc
from run_trusted_media_daemon_component import WORKERS, policy

TAG = "teamaibox/trusted-media-service:private-readiness-20260907-a1"
LOCAL_IMAGE = "sha256:d492f575c679379c89cbf24c67e261d89112eb324d3496d40ee260f7a750697d"
IMAGE = "sha256:bd450bb228ffed8ce3e14558ce4c3d58da911e5028fa4310fd6680a8a2bc9d98"
RUN = re.compile(r"casting-readiness-component-20[0-9]{6}-a[1-9][0-9]{0,3}")
MODULES = tuple(sorted(str(p.relative_to(ROOT)) for package in ("trusted_media_service", "trusted_media_runtime")
    for p in (ROOT/"services"/package).rglob("*.py")))
SOURCES = MODULES + ("tools/run_trusted_media_readiness_component.py", "tools/probe_trusted_media_daemon.py",
    "tools/run_trusted_media_daemon_component.py", "tools/run_trusted_media_hdmi_component.py",
    "deploy/casting/TrustedMediaReadiness.arm64.Dockerfile", "deploy/casting/TrustedMediaReadiness.arm64.Dockerfile.dockerignore")

def bindings(): return {name: digest((ROOT/name).read_bytes()) for name in SOURCES}
def workers():
    result = []
    for name in WORKERS:
        value = inspect("container", name)
        if not value or not value["State"]["Running"] or value["State"].get("Health",{}).get("Status") != "healthy":
            raise RuntimeError("protected_office_worker_unhealthy")
        result.append({"name":name,"containerId":value["Id"],"imageId":value["Image"],
                       "startedAt":value["State"]["StartedAt"],"healthy":True})
    return result

def run(run_id):
    if not RUN.fullmatch(run_id): raise ValueError("bounded_run_id_required")
    path = ROOT/"evidence/validation/components"/(run_id+".json")
    claim = ROOT/"tmp"/(run_id+".claim")
    name = "teamaibox-"+run_id
    if path.exists() or claim.exists() or inspect("container",name): raise ValueError("run_identity_occupied")
    local = json.loads(subprocess.check_output(["docker","image","inspect",TAG]))[0]
    remote = inspect("image",IMAGE)
    if local["Id"] != LOCAL_IMAGE or not remote or remote["Id"] != IMAGE or remote["Architecture"] != "arm64":
        raise ValueError("exact_arm64_image_required")
    before = workers()
    memory = ssh("awk '/MemAvailable:/{print $2}' /proc/meminfo")
    if memory.returncode or int(memory.stdout.strip())*1024 < 48*2**30+256*2**20:
        raise ValueError("office_core_and_transient_headroom_required")
    display = ssh("systemctl is-active display-manager").stdout.decode().strip()
    if display != "active": raise ValueError("expected_display_state_changed")
    with claim.open("x") as file: file.write(run_id)
    report = {"schemaVersion":1,"runId":run_id,"status":"failed","startedAt":utc(),
        "imageId":IMAGE,"localImageId":LOCAL_IMAGE,"sources":bindings(),"workersBefore":before,"displayBefore":display,
        "workerMutations":False,"hostMutations":False,"productAccepted":False,"receiverEnabled":False,"cleanupConfirmed":False}
    container_id = None
    try:
        command = ["docker","create","-i","--name",name,"--label","org.teamaibox.run="+run_id,
            "--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
            "--memory","256m","--memory-swap","256m","--cpus","1","--pids-limit","64","--log-driver","none",
            "--tmpfs","/run/teamaibox:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m",
            "--entrypoint","/usr/bin/python3",IMAGE,"-"]
        result = ssh(shlex.join(command))
        if result.returncode: raise RuntimeError("container_create_failed")
        owned = inspect("container",name)
        container_id = owned["Id"]
        report["containerId"], report["policy"] = container_id, policy(owned)
        result = ssh(shlex.join(["docker","start","--attach","--interactive",container_id]), timeout=60,
                     input=(ROOT/"tools/probe_trusted_media_daemon.py").read_bytes())
        report["returnCode"] = result.returncode
        if len(result.stdout)>32768: raise RuntimeError("probe_response_oversized")
        report["probe"] = json.loads(result.stdout)
        ended = inspect("container",container_id)
        report["exitCode"],report["oomKilled"] = ended["State"]["ExitCode"],ended["State"]["OOMKilled"]
        if result.returncode or report["probe"]["status"] != "passed": raise RuntimeError("probe_failed")
        report["status"] = "passed"
    except Exception as error:
        report["errorCategory"] = type(error).__name__
    finally:
        try:
            owned = inspect("container",name)
            if owned:
                if owned["Image"] != IMAGE or owned["Config"]["Labels"].get("org.teamaibox.run") != run_id \
                        or (container_id is not None and owned["Id"] != container_id):
                    raise RuntimeError("owned_identity_changed")
                result = ssh(shlex.join(["docker","rm","--force",owned["Id"]]))
                if result.returncode: raise RuntimeError("owned_cleanup_failed")
            report["cleanupConfirmed"] = inspect("container",name) is None
            report["workersAfter"] = workers()
            report["displayAfter"] = ssh("systemctl is-active display-manager").stdout.decode().strip()
            report["sourcesUnchanged"] = report["sources"] == bindings()
            if not report["cleanupConfirmed"] or not report["sourcesUnchanged"] or before != report["workersAfter"] or display != report["displayAfter"]:
                raise RuntimeError("postflight_changed")
        except Exception as error:
            report["status"],report["cleanupErrorCategory"] = "failed",type(error).__name__
        report["completedAt"] = utc()
        report["evidenceDigest"] = digest(canonical(report))
        with path.open("x") as file: json.dump(report,file,sort_keys=True,indent=2)
        print(json.dumps({k:report[k] for k in ("runId","status","cleanupConfirmed","productAccepted","evidenceDigest")}))
    return 0 if report["status"] == "passed" else 1

def validate(path):
    value = json.loads(path.read_bytes())
    expected = value.pop("evidenceDigest")
    assert digest(canonical(value)) == expected and RUN.fullmatch(value["runId"])
    assert path == ROOT/"evidence/validation/components"/(value["runId"]+".json")
    assert value["status"] == "passed" and value["returnCode"] == value["exitCode"] == 0 and value["oomKilled"] is False
    assert value["imageId"] == IMAGE and value["localImageId"] == LOCAL_IMAGE
    assert value["sourcesUnchanged"] and value["sources"] == bindings() and value["cleanupConfirmed"]
    assert value["workersBefore"] == value["workersAfter"] == workers()
    assert value["displayBefore"] == value["displayAfter"] == "active"
    assert all(value[k] is False for k in ("workerMutations","hostMutations","productAccepted","receiverEnabled"))
    assert value["policy"] == {"imageId":IMAGE,"user":"65532:65532","network":"none","readOnly":True,
        "privileged":False,"capDrop":["ALL"],"capAdd":None,"securityOpt":["no-new-privileges"],"memoryBytes":256*2**20,
        "swapBytes":256*2**20,"nanoCpus":10**9,"pidsLimit":64,"devices":[],"deviceRequests":None,"binds":None,
        "tmpfs":{"/run/teamaibox":"rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m"},"logDriver":"none"}
    probe = value["probe"]
    assert probe["status"] == "passed" and probe["exitCode"] == 0 and probe["receiverChildrenBeforeStop"] == 0
    for key in ("realTls","syntheticCredentials","nonRootWithoutCapabilities","authenticatedControlPassed","replayRejected",
                "otherServiceRejected","unauthenticatedRejected","listenerClosed","cleanupConfirmed",
                "authenticatedReadinessPassed","unavailableOutputsNotFaked"):
        assert probe[key] is True
    assert all(probe[k] is False for k in ("productAccepted","appleSenderAccepted","receiverAdvertised","recording","mediaSessionRequested"))
    assert probe["imageSources"] == {name:digest((ROOT/name).read_bytes()) for name in MODULES}
    assert inspect("container","teamaibox-"+value["runId"]) is None and inspect("image",IMAGE)["Architecture"] == "arm64"
    print(json.dumps({"runId":value["runId"],"strictValidation":"passed","productAccepted":False,"evidenceDigest":expected}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-id"); group.add_argument("--evidence",type=Path)
    args = parser.parse_args()
    if args.run_id: raise SystemExit(run(args.run_id))
    validate(args.evidence.resolve())
