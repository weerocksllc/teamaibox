"""Main-box private runtime + SFU check; no session, discovery or GPU use."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time

from run_trusted_media_hdmi_component import ROOT, HOST, ssh, inspect, digest, canonical, utc
from run_trusted_media_readiness_component import workers

IMAGE = "sha256:d6e8f19b3462e81f8b2d7d6dab51eb661b47ca9fde177b0af00dced34b8c44be"
LOCAL_IMAGE = "sha256:44a67a2f8a1e8c6ceb12a41ac973944508cd3c1ed4db9aa40abbbfd93775ba73"
TAG = "teamaibox/trusted-media-service:private-gateway-20260908-a3"
SFU_IMAGE = "sha256:5796e112169dfdf228d085f43f5833593654785a62782b3daed5222911d4e685"
SFU_MANIFEST = "sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a"
RUN = re.compile(r"casting-connected-component-20[0-9]{6}-a[1-9][0-9]{0,3}")
MODULES = tuple(sorted(str(p.relative_to(ROOT)) for folder in ("trusted_media_service","trusted_media_runtime")
                       for p in (ROOT/"services"/folder).rglob("*.py")))
SOURCES = MODULES + ("tools/run_trusted_media_connected_component.py","tools/probe_trusted_media_daemon.py",
    "tests/test_trusted_media_appliance.py","tests/test_trusted_media_sfu_gateway.py",
    "deploy/casting/TrustedMediaGateway.arm64.Dockerfile","deploy/casting/TrustedMediaGateway.arm64.Dockerfile.dockerignore")


def bindings(): return {name:digest((ROOT/name).read_bytes()) for name in SOURCES}
def checked(command, **options):
    result=ssh(command,**options)
    if result.returncode: raise RuntimeError("remote_component_command_failed")
    return result.stdout


def policy(value):
    host, config = value["HostConfig"],value["Config"]
    return {"imageId":value["Image"],"user":config["User"],"network":host["NetworkMode"],
        "readOnly":host["ReadonlyRootfs"],"memoryBytes":host["Memory"],"swapBytes":host["MemorySwap"],
        "nanoCpus":host["NanoCpus"],"pidsLimit":host["PidsLimit"],"capDrop":host["CapDrop"],
        "capAdd":host["CapAdd"],"securityOpt":host["SecurityOpt"],"privileged":host["Privileged"],
        "devices":host["Devices"],"deviceRequests":host.get("DeviceRequests"),"binds":host["Binds"],
        "tmpfs":host.get("Tmpfs",{}),"logDriver":host["LogConfig"]["Type"]}


def expected_policy(role):
    memory=(384 if role=="media" else 256)*2**20
    return {"imageId":IMAGE if role=="media" else SFU_IMAGE,"user":"65532:65532","network":"host",
        "readOnly":True,"memoryBytes":memory,"swapBytes":memory,"nanoCpus":10**9,"pidsLimit":96,
        "capDrop":["ALL"],"capAdd":None,"securityOpt":["no-new-privileges"],"privileged":False,
        "devices":[],"deviceRequests":None,"binds":None,
        "tmpfs":{"/run/teamaibox":"rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m"} if role=="media" else {},
        "logDriver":"none"}


def run(run_id):
    if not RUN.fullmatch(run_id): raise ValueError("bounded_run_identity_required")
    path=ROOT/"evidence/validation/components"/(run_id+".json")
    claim=ROOT/"tmp"/(run_id+".claim")
    names={role:"teamaibox-"+role+"-"+run_id for role in ("media","sfu")}
    if path.exists() or claim.exists() or any(inspect("container",n) for n in names.values()):
        raise ValueError("run_identity_occupied")
    local=json.loads(subprocess.check_output(["docker","image","inspect",TAG]))[0]
    if local["Id"] != LOCAL_IMAGE or local["Architecture"] != "arm64": raise ValueError("exact_local_image_required")
    for image in (IMAGE,SFU_IMAGE):
        value=inspect("image",image)
        if not value or value["Id"]!=image or value["Architecture"]!="arm64": raise ValueError("exact_remote_image_required")
    before=workers()
    available=int(checked("awk '/MemAvailable:/{print $2}' /proc/meminfo").strip())*1024
    if available < 48*2**30+640*2**20: raise ValueError("office_headroom_required")
    display=checked("systemctl is-active display-manager").decode().strip()
    if display!="active": raise ValueError("display_state_changed")
    # No routes, VPN, desktop, host configuration or office container changes.
    # Only new, exact-owned listeners/processes are used during this check.
    # A closed TCP connection may remain in TIME_WAIT. SO_REUSEADDR allows
    # that normal state but still cannot bind over an active TCP listener.
    preflight="import socket\ns=[]\nfor kind,port in [(socket.SOCK_STREAM,17880),(socket.SOCK_STREAM,17881),(socket.SOCK_DGRAM,17882)]:\n p=socket.socket(socket.AF_INET,kind)\n if kind==socket.SOCK_STREAM:p.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n p.bind(('0.0.0.0',port));s.append(p)\n"
    checked("python3 -",input=preflight.encode())
    with claim.open("x") as file: file.write(run_id)
    report={"schemaVersion":1,"runId":run_id,"status":"failed","startedAt":utc(),"sources":bindings(),
        "scope":"main-box-private-connected-component-only","imageId":IMAGE,"localImageId":LOCAL_IMAGE,
        "sfuImageId":SFU_IMAGE,"sfuManifest":SFU_MANIFEST,"workersBefore":before,"displayBefore":display,
        "availableBytesBefore":available,"containerLimitBytes":640*2**20,"containers":{},
        "workerMutations":False,"hostConfigurationMutations":False,"receiverAdvertised":False,"gpuUsed":False,
        "productAccepted":False,"browserAccepted":False,"appleSenderAccepted":False,"cleanupConfirmed":False}
    sfu_process=None
    try:
        for role in ("sfu","media"):
            args=["docker","create","-i","--name",names[role],"--label","org.teamaibox.run="+run_id,
                "--network","host","--user","65532:65532","--read-only","--cap-drop","ALL",
                "--security-opt","no-new-privileges","--memory",str(384 if role=="media" else 256)+"m",
                "--memory-swap",str(384 if role=="media" else 256)+"m","--cpus","1","--pids-limit","96","--log-driver","none"]
            if role=="media":
                args += ["--tmpfs","/run/teamaibox:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=32m",
                    "--env","TEAMAIBOX_COMPONENT_SFU_PORT=17880","--env","GST_REGISTRY=/run/teamaibox/gst-registry.bin",
                    "--env","TEAMAIBOX_COMPONENT_COMBINED=1",
                    "--entrypoint","/usr/bin/python3",IMAGE,"-"]
            else: args += [SFU_IMAGE,"--config","/dev/stdin"]
            cid=checked(shlex.join(args)).decode().strip()
            value=inspect("container",cid)
            report["containers"][role]={"containerId":cid,"policy":policy(value)}
            if policy(value)!=expected_policy(role): raise RuntimeError("container_policy_mismatch")
        sfuid=report["containers"]["sfu"]["containerId"]
        sfu_process=subprocess.Popen(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15",
            "-o","ServerAliveCountMax=3",HOST,shlex.join(["docker","start","--attach","--interactive",sfuid])],
            stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        # Synthetic credentials are for this zero-room fixture only, on stdin,
        # never on Docker argv/environment or in a persistent configuration.
        sfu_process.stdin.write(b"port: 17880\nbind_addresses: [127.0.0.1]\nkeys:\n  synthetic-daemon-key: synthetic-daemon-secret-not-for-deployment\nrtc:\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  tcp_port: 17881\n  udp_port: 17882\nlogging:\n  level: error\n")
        sfu_process.stdin.close()
        for _ in range(40):
            if sfu_process.poll() is not None: raise RuntimeError("sfu_start_failed")
            if ssh("python3 -c 'import socket;s=socket.create_connection((\"127.0.0.1\",17880),.2);s.close()'").returncode==0: break
            time.sleep(.1)
        else: raise RuntimeError("sfu_start_timeout")
        cid=report["containers"]["media"]["containerId"]
        result=ssh(shlex.join(["docker","start","--attach","--interactive",cid]),timeout=60,
                   input=(ROOT/"tools/probe_trusted_media_daemon.py").read_bytes())
        if len(result.stdout)>32768: raise RuntimeError("probe_response_oversized")
        report["probe"]=json.loads(result.stdout)
        state=inspect("container",cid)["State"]
        report.update(returnCode=result.returncode,exitCode=state["ExitCode"],oomKilled=state["OOMKilled"])
        if result.returncode or report["probe"]["status"]!="passed": raise RuntimeError("connected_probe_failed")
        report["status"]="passed"
    except Exception as error:
        report["errorCategory"]=type(error).__name__
        report["errorCode"]=str(error) if re.fullmatch(r"[a-z][a-z0-9_]{2,99}",str(error)) else "connected_component_failed"
    finally:
        try:
            for role in ("media","sfu"):
                value=inspect("container",names[role])
                if value:
                    recorded=report["containers"].get(role,{})
                    if value["Config"]["Labels"].get("org.teamaibox.run")!=run_id or value["Image"]!=(IMAGE if role=="media" else SFU_IMAGE) \
                        or recorded.get("containerId",value["Id"])!=value["Id"]: raise RuntimeError("owned_identity_changed")
                    checked(shlex.join(["docker","stop","--time","3",value["Id"]]),timeout=15)
                    checked(shlex.join(["docker","rm",value["Id"]]))
            report["cleanupConfirmed"]=all(inspect("container",name) is None for name in names.values())
            report["workersAfter"]=workers()
            report["displayAfter"]=checked("systemctl is-active display-manager").decode().strip()
            report["sourcesUnchanged"]=report["sources"]==bindings()
            checked("python3 -",input=preflight.encode())
            report["ownedPortsReleased"]=True
            if not report["cleanupConfirmed"] or not report["sourcesUnchanged"] or before!=report["workersAfter"] or display!=report["displayAfter"]:
                raise RuntimeError("postflight_changed")
        except Exception as error:
            report["status"],report["cleanupErrorCategory"]="failed",type(error).__name__
            report["cleanupErrorCode"]=str(error) if re.fullmatch(r"[a-z][a-z0-9_]{2,99}",str(error)) else "connected_cleanup_failed"
        if sfu_process is not None:
            try: sfu_process.wait(timeout=10)
            except subprocess.TimeoutExpired: sfu_process.terminate();sfu_process.wait(timeout=5);report["status"]="failed"
        report["completedAt"]=utc();report["evidenceDigest"]=digest(canonical(report))
        with path.open("x") as file: json.dump(report,file,sort_keys=True,indent=2)
        print(json.dumps({key:report[key] for key in ("runId","status","cleanupConfirmed","productAccepted","evidenceDigest")}))
    return 0 if report["status"]=="passed" else 1


def validate(path):
    value=json.loads(path.read_bytes()); signed=value.pop("evidenceDigest")
    assert signed==digest(canonical(value)) and RUN.fullmatch(value["runId"])
    assert path==ROOT/"evidence/validation/components"/(value["runId"]+".json")
    assert value["scope"]=="main-box-private-connected-component-only" and value["status"]=="passed"
    assert value["sources"]==bindings() and value["sourcesUnchanged"] and value["cleanupConfirmed"] and value["ownedPortsReleased"]
    assert value["imageId"]==IMAGE and value["localImageId"]==LOCAL_IMAGE and value["sfuImageId"]==SFU_IMAGE and value["sfuManifest"]==SFU_MANIFEST
    assert value["returnCode"]==value["exitCode"]==0 and value["oomKilled"] is False
    assert value["workersBefore"]==value["workersAfter"]==workers() and value["displayBefore"]==value["displayAfter"]=="active"
    assert value["containerLimitBytes"]==640*2**20 and value["availableBytesBefore"]>=48*2**30+value["containerLimitBytes"]
    for flag in ("workerMutations","hostConfigurationMutations","receiverAdvertised","gpuUsed","productAccepted","browserAccepted","appleSenderAccepted"):
        assert value[flag] is False
    assert set(value["containers"])=={"sfu","media"}
    for role,row in value["containers"].items():
        assert re.fullmatch(r"[a-f0-9]{64}",row["containerId"]) and row["policy"]==expected_policy(role)
        assert inspect("container",row["containerId"]) is None
    probe=value["probe"]
    for key in ("connectedSfuProbe","combinedApplianceOwner","realSfuReadinessPassed","gatewayListenersClosed","realTls","syntheticCredentials",
        "nonRootWithoutCapabilities","authenticatedControlPassed","replayRejected","otherServiceRejected","unauthenticatedRejected",
        "authenticatedReadinessPassed","unavailableOutputsNotFaked","listenerClosed","cleanupConfirmed"):
        assert probe[key] is True
    assert probe["gatewayExitCode"]==probe["exitCode"]==probe["receiverChildrenBeforeStop"]==0
    assert all(probe[k] is False for k in ("mediaSessionRequested","receiverAdvertised","recording","productAccepted","appleSenderAccepted"))
    assert probe["imageSources"]=={name:digest((ROOT/name).read_bytes()) for name in MODULES}
    assert probe["observedReadiness"]["outputs"]=={"browser":{"available":True,"reasonCode":None},"hdmi":{"available":False,"reasonCode":"cast_hdmi_unconfigured"}}
    print(json.dumps({"runId":value["runId"],"strictValidation":"passed","productAccepted":False,"evidenceDigest":signed}))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-id");group.add_argument("--evidence",type=Path)
    args=parser.parse_args()
    if args.run_id: raise SystemExit(run(args.run_id))
    validate(args.evidence.resolve())
