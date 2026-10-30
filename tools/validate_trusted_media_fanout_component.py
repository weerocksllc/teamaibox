"""Independent fail-closed validation of the synthetic eight-viewer component."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {"tools/run_trusted_media_fanout_component.py", "tools/validate_trusted_media_fanout_component.py",
    "services/trusted_media_runtime/sfu_gateway.py", "services/trusted_media_runtime/main.py",
    "tests/test_trusted_media_sfu_gateway.py",
    "tests/test_trusted_media_fanout_real_media.py", "tests/test_trusted_media_webrtc_real_media.py",
    "services/trusted_media_service/webrtc_media_output.py", "services/trusted_media_service/gdp_media_ingress.py",
    "services/trusted_media_service/publisher_credentials.py", "services/trusted_media_service/viewer_token_issuer.py",
    "services/trusted_media_service/livekit_browser_sink.py", "services/trusted_media_service/livekit_room_control.py",
    "services/trusted_media_service/callback_client.py", "services/trusted_media_service/tls_runtime_server.py",
    "services/trusted_media_service/runtime_api.py"}


def check(value):
    def require(condition):
        if not condition:
            raise ValueError("casting fanout component evidence rejected")
    sha = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
    unsigned = {key: item for key, item in value.items() if key != "evidenceDigest"}
    require(value.get("evidenceDigest") == sha(json.dumps(unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()))
    require(value.get("schemaVersion") == 1 and re.fullmatch(r"casting-fanout-component-20[0-9]{6}-a[1-9][0-9]*", value.get("runId", "")))
    require(value.get("scope") == "isolated eight-GStreamer-viewer synthetic media component")
    require(value.get("status") == "passed" and value.get("returnCode") == 0 and value.get("cleanupConfirmed") is True)
    require(value.get("mediaImageId") == "sha256:e8175305a50fd983bfd2ccd819d1a8bf58db0c5f619a737049f1276ba1313f06")
    require(value.get("sfuImage") == "docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a")
    require(re.fullmatch(r"[a-f0-9]{64}", value.get("sfuContainerId", "")))
    for key in ("productAccepted", "browserAccepted", "appleSenderAccepted", "hdmiAccepted", "receiverAdvertised", "gpuUsed", "hostPortsPublished"):
        require(value.get(key) is False)
    rows = value.get("sources", [])
    require(len(rows) == len(SOURCES) and {row.get("path") for row in rows} == SOURCES)
    for row in rows:
        require(row["sha256"] == sha((ROOT / row["path"]).read_bytes()))
    facts = value.get("facts", {})
    require(facts.get("realViewerCount") == 8 and facts.get("queueBoundPerTrack") == 2)
    for key in ("minimumDecodedVideoSamples", "minimumDecodedAudioSamples"):
        require(type(facts.get(key)) is int and facts[key] >= 5)
    for key in ("privateGdpIngress", "productionPublisherAdapter", "tls13", "oneVideoEncoder", "singleSfuConnection",
                "removedViewerMediaStopped", "remainingViewerContinued", "publisherStopEndedAllMedia", "roomDeletionConfirmed",
                "productionBrowserSink", "productionSfuGateway", "productionViewerGateway", "pinnedMtlsRoomControl", "ninthAdmissionDeniedAfterTokenExpiry"):
        require(facts.get(key) is True)
    for key in ("appleSenderAccepted", "browserAccepted", "hdmiAccepted"):
        require(facts.get(key) is False)
    return {"valid": True, "runId": value["runId"], "evidenceDigest": value["evidenceDigest"],
            "productAccepted": False, "browserAccepted": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    print(json.dumps(check(json.loads(parser.parse_args().evidence.read_text()))))
