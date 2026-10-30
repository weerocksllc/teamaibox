"""Own only an isolated SFU and CPU-bounded synthetic media component test.

This does not advertise a receiver or qualify an Apple/HDMI/browser journey.
Every invocation records its own immutable result after exact cleanup.
"""
import os
import argparse
from datetime import datetime, timezone
import hashlib
import json
import ipaddress
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run-id",required=True)
RUN=parser.parse_args().run_id
MEDIA_IMAGE=os.environ.get('TEAMAIBOX_RUN_CASTING_PRODUCTION_BRIDGE_MEDIA_IMAGE')
if not re.fullmatch(r'sha256:[0-9a-f]{64}', MEDIA_IMAGE or ''):
    raise ValueError('TEAMAIBOX_RUN_CASTING_PRODUCTION_BRIDGE_MEDIA_IMAGE must be an explicit full image ID')
assert re.fullmatch(r"casting-production-bridge-20[0-9]{6}-a[1-9][0-9]*",RUN)
EVIDENCE=ROOT/"evidence/validation/components"/(RUN+".json")
assert not EVIDENCE.exists() and not EVIDENCE.with_name(RUN+"-failure.json").exists()
CLAIM=ROOT/"tmp"/(RUN+".claim")
with CLAIM.open("x") as claim: claim.write(RUN+"\n")
def utc(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
def digest(data): return "sha256:"+hashlib.sha256(data).hexdigest()
SOURCES=("services/trusted_media_service/webrtc_media_output.py","services/trusted_media_service/native_receiver_process.py","tools/run_casting_production_bridge.py","tools/validate_trusted_media_webrtc_component.py",
    "tests/test_trusted_media_production_bridge.py","services/trusted_media_service/publisher_credentials.py",
    "services/trusted_media_service/viewer_token_issuer.py","deploy/casting/TrustedMediaGdpWebrtc.arm64.Dockerfile",
    "deploy/casting/TrustedMediaIce.arm64.Dockerfile")
sources=[{"path":path,"sha256":digest((ROOT/path).read_bytes())} for path in SOURCES]
report={"schemaVersion":1,"runId":RUN,"status":"failed","startedAt":utc(),"sources":sources,
    "scope":"isolated one-viewer synthetic media component","productAccepted":False,"browserAccepted":False,
    "appleSenderAccepted":False,"hdmiAccepted":False,"receiverAdvertised":False,"gpuUsed":False,
    "hostPortsPublished":False,"cleanupConfirmed":False}
SFU="teamaibox-cast-real-media-sfu-"+RUN.removeprefix("casting-production-bridge-")
MEDIA="teamaibox-cast-real-media-gst-"+RUN.removeprefix("casting-production-bridge-")
NETWORK="teamaibox-cast-real-media-private-"+RUN.removeprefix("casting-production-bridge-")
SFU_IMAGE="docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a"
for name in (SFU,MEDIA):
    assert subprocess.run(["docker","inspect",name],capture_output=True).returncode!=0
assert json.loads(subprocess.check_output(["docker","image","inspect",MEDIA_IMAGE]))[0]["Id"]==MEDIA_IMAGE
report.update(mediaImageId=MEDIA_IMAGE,sfuImage=SFU_IMAGE)
assert subprocess.run(["docker","network","inspect",NETWORK],capture_output=True).returncode!=0
subprocess.run(["docker","network","create","--internal",NETWORK],check=True,stdout=subprocess.DEVNULL)
network=json.loads(subprocess.check_output(["docker","network","inspect",NETWORK]))[0]
assert network["Internal"] is True
address=str(ipaddress.ip_network(network["IPAM"]["Config"][0]["Subnet"]).network_address+2)
config=("port: 7880\nbind_addresses: [127.0.0.1]\nkeys:\n  room-test-key: synthetic-only-not-a-deployment-livekit-secret\nrtc:\n  node_ip: "+address+"\n  use_external_ip: false\n  tcp_port: 7881\n  udp_port: 7882\nlogging:\n  level: error\n").encode()
sfu=None
try:
    sfu=subprocess.Popen(["docker","run","--rm","-i","--name",SFU,"--network",NETWORK,"--ip",address,"--read-only",
        "--user","65532:65532","--cap-drop","ALL","--security-opt","no-new-privileges",
        "--memory","512m","--cpus","1","--pids-limit","128","--log-driver","none",SFU_IMAGE,"--config","/dev/stdin"],
        stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    sfu.stdin.write(config)
    sfu.stdin.close()
    for _ in range(30):
        assert sfu.poll() is None
        info=subprocess.run(["docker","inspect",SFU,"--format","{{.State.Running}}"],capture_output=True,text=True)
        if info.returncode==0 and info.stdout.strip()=="true": break
        time.sleep(0.1)
    time.sleep(1)
    sfu_info=json.loads(subprocess.check_output(["docker","inspect",SFU]))[0]
    assert sfu_info["State"]["Running"] and sfu_info["HostConfig"]["Memory"]==512*1024**2
    assert sfu_info["HostConfig"]["ReadonlyRootfs"] and not sfu_info["HostConfig"]["PortBindings"]
    assert not sfu_info["Mounts"] and not sfu_info["HostConfig"].get("DeviceRequests")
    report["sfuContainerId"]=sfu_info["Id"]
    command=["docker","run","--rm","--name",MEDIA,"--network","container:"+SFU,"--read-only",
        "--user","65532:65532","--cap-drop","ALL","--security-opt","no-new-privileges",
        "--memory","2g","--memory-swap","2g","--cpus","2","--pids-limit","256","--log-driver","none",
        "--tmpfs","/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
        "--env","HOME=/tmp","--env","GST_REGISTRY=/tmp/gst-registry.bin","--env","GST_DEBUG=0",
        "--env","RUST_LOG=off","--env","TEAMAIBOX_TEST_REAL_MEDIA=1",
        "--mount","type=bind,src="+str(ROOT/"services")+",dst=/workspace/services,readonly",
        "--mount","type=bind,src="+str(ROOT/"tests")+",dst=/workspace/tests,readonly",
        "--workdir","/workspace","--entrypoint","python3",MEDIA_IMAGE,"-c",
        "import sys,unittest; from tests.test_trusted_media_production_bridge import ProductionBridgeMediaTest; result=unittest.TextTestRunner(stream=sys.stdout,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProductionBridgeMediaTest)); sys.exit(not result.wasSuccessful())"]
    result=subprocess.run(command,timeout=90,capture_output=True,text=True)
    diagnostic=result.stdout+result.stderr
    diagnostic=diagnostic.replace("synthetic-only-not-a-deployment-livekit-secret","[secret]")
    diagnostic=re.sub(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}","[token]",diagnostic)
    diagnostic=re.sub(r"(?:https?|wss?)://[^\s]+","[endpoint]",diagnostic)
    print(diagnostic if len(diagnostic)<=9000 else diagnostic[:7000]+"\n[bounded middle omitted]\n"+diagnostic[-2000:],flush=True)
    report["returnCode"]=result.returncode
    match=re.search(r'(\{"realVideoSamples"[^\n]+\})',result.stdout)
    if result.returncode==0 and match:
        report["facts"]=json.loads(match.group(1))
        assert all(digest((ROOT/item["path"]).read_bytes())==item["sha256"] for item in sources)
        report["status"]="passed"
    else:
        report["diagnostic"]=diagnostic[:3500]+("\n[bounded]" if len(diagnostic)>3500 else "")
finally:
    for name in (MEDIA,SFU):
        # Only exact names owned above; no shared volume/network cleanup.
        subprocess.run(["docker","stop","--time","3",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if sfu: sfu.wait(timeout=10)
    subprocess.run(["docker","network","rm",NETWORK],check=True,stdout=subprocess.DEVNULL)
    report["cleanupConfirmed"]=all(subprocess.run(["docker","inspect",name],capture_output=True).returncode!=0 for name in (MEDIA,SFU))
    report["cleanupConfirmed"] &= subprocess.run(["docker","network","inspect",NETWORK],capture_output=True).returncode!=0
    if not report["cleanupConfirmed"]: report["status"]="failed"
    report["completedAt"]=utc()
    report["evidenceDigest"]=digest(json.dumps(report,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode())
    with EVIDENCE.open("x") as output: json.dump(report,output,ensure_ascii=False,sort_keys=True,indent=2)
    print(json.dumps({"runId":RUN,"status":report["status"],"evidenceDigest":report["evidenceDigest"],"cleanupConfirmed":report["cleanupConfirmed"]}),flush=True)
raise SystemExit(0 if report["status"]=="passed" else 1)

