"""Strictly validate the isolated real-media component evidence, not product acceptance."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
def digest(value): return "sha256:"+hashlib.sha256(value).hexdigest()

def validate(path):
    value=json.loads(path.read_text())
    assert value["schemaVersion"]==1 and value["status"]=="passed" and value["returnCode"]==0
    assert re.fullmatch(r"casting-real-media-20[0-9]{6}-a[1-9][0-9]*",value["runId"])
    assert path.name==value["runId"]+".json"
    assert value["evidenceDigest"]==digest(json.dumps({k:v for k,v in value.items() if k!="evidenceDigest"},sort_keys=True,separators=(",",":"),ensure_ascii=False).encode())
    duration=(datetime.fromisoformat(value["completedAt"].replace("Z","+00:00"))-datetime.fromisoformat(value["startedAt"].replace("Z","+00:00"))).total_seconds()
    assert 0<duration<120 and value["cleanupConfirmed"] is True
    for key in ("productAccepted","browserAccepted","appleSenderAccepted","hdmiAccepted","receiverAdvertised","gpuUsed","hostPortsPublished"):
        assert value[key] is False
    facts=value["facts"]
    assert type(facts["realVideoSamples"]) is int and facts["realVideoSamples"]>=10
    assert type(facts["realAudioSamples"]) is int and facts["realAudioSamples"]>=10
    for key in ("tls13","singleSfuConsumer","oneVideoEncoder","removedViewerMediaStopped","roomDeletionConfirmed"):
        assert facts[key] is True
    for key in ("appleSenderAccepted","browserAccepted","hdmiAccepted"):
        assert facts[key] is False
    expected={"tools/run_trusted_media_webrtc_component.py","tools/validate_trusted_media_webrtc_component.py",
        "tests/test_trusted_media_webrtc_real_media.py","services/trusted_media_service/publisher_credentials.py",
        "services/trusted_media_service/viewer_token_issuer.py","deploy/casting/TrustedMediaGdpWebrtc.arm64.Dockerfile",
        "deploy/casting/TrustedMediaIce.arm64.Dockerfile"}
    assert len(value["sources"])==len(expected) and {item["path"] for item in value["sources"]}==expected
    for item in value["sources"]: assert digest((ROOT/item["path"]).read_bytes())==item["sha256"]
    assert value["mediaImageId"]=="sha256:e8175305a50fd983bfd2ccd819d1a8bf58db0c5f619a737049f1276ba1313f06"
    assert value["sfuImage"]=="docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a"
    image=json.loads(subprocess.check_output(["docker","image","inspect",value["mediaImageId"]],timeout=10))[0]
    assert image["Id"]==value["mediaImageId"] and image["Architecture"]=="arm64"
    suffix=value["runId"].removeprefix("casting-real-media-")
    for prefix in ("teamaibox-cast-real-media-sfu-","teamaibox-cast-real-media-gst-"):
        assert subprocess.run(["docker","inspect",prefix+suffix],capture_output=True,timeout=10).returncode!=0
    assert subprocess.run(["docker","network","inspect","teamaibox-cast-real-media-private-"+suffix],capture_output=True,timeout=10).returncode!=0
    return {"valid":True,"runId":value["runId"],"componentReady":True,"productAccepted":False,"evidenceDigest":value["evidenceDigest"]}

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence",type=Path,required=True)
    print(json.dumps(validate(parser.parse_args().evidence),sort_keys=True))
