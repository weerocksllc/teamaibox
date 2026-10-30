"""Validate only the exact claimed HDMI component; never imply Apple acceptance."""
import argparse
import json
from pathlib import Path
import re

from run_trusted_media_hdmi_component import ROOT, SOURCES, IMAGE_CONFIG, SESSION_IMAGE, SESSION_SOURCES, MIN_AVAILABLE, canonical, digest, inspect


def validate(path):
    report = json.loads(path.read_bytes())
    expected = report.pop("evidenceDigest")
    assert digest(canonical(report)) == expected, "evidence changed"
    assert re.fullmatch(r"casting-hdmi-component-20[0-9]{6}-a[1-9][0-9]*", report["runId"])
    assert path.name == report["runId"] + ".json"
    assert report["status"] == "passed" and report["returnCode"] == 0
    seconds = report["requestedPlaybackSeconds"]
    assert type(seconds) is int and 5 <= seconds <= 60
    session_api = report.get("sessionApiComponent", False)
    assert type(session_api) is bool
    assert report["imageId"] == (SESSION_IMAGE if session_api else IMAGE_CONFIG)
    assert report["cleanupConfirmed"] is True and report["unrelatedContainersUnchanged"] is True
    assert report["hostDevicesUnchanged"] is True and report["hostDevicesBefore"] == report["hostDevicesAfter"]
    assert report["beforeContainers"] == report["afterContainers"]
    assert report["displayManagerBefore"] == report["displayManagerAfter"]
    assert report["preflightMemAvailableBytes"] >= MIN_AVAILABLE
    assert all(report[key] is False for key in ("hostMutations", "workerMutations", "receiverAdvertised", "productAccepted"))
    assert report["sourcesUnchanged"] is True
    assert [source["path"] for source in report["sources"]] == list(SESSION_SOURCES if session_api else SOURCES)
    assert all(digest((ROOT / source["path"]).read_bytes()) == source["sha256"] for source in report["sources"])
    policy = report["containerPolicy"]
    assert policy["imageId"] == report["imageId"] and policy["user"] == "0:0"
    assert policy["readOnly"] is True and policy["privileged"] is False and policy["oomKilled"] is False
    assert policy["networkMode"] == "none" and policy["deviceRequests"] in (None, [])
    assert policy["capDrop"] == ["ALL"] and set(policy["capAdd"]) == {"CAP_SETUID", "CAP_SETGID"}
    assert policy["securityOpt"] == ["no-new-privileges"]
    assert policy["memoryBytes"] == policy["memorySwapBytes"] == 512 * 1024**2
    assert policy["logDriver"] == "none" and policy["binds"] in (None, [])
    assert policy["devices"] == [{"PathOnHost": value, "PathInContainer": value, "CgroupPermissions": "rw"}
        for value in ("/dev/dri/card1", "/dev/snd/pcmC0D3p", "/dev/snd/controlC0")]
    probe = report["probe"]
    assert probe["requestedPlaybackSeconds"] == seconds
    assert probe["mediaProcessIdentity"] == {"privateDeviceInodesOnly": True, "uid": 65532, "gid": 65532,
        "effectiveCapabilities": 0, "permittedCapabilities": 0, "noNewPrivileges": True}
    assert probe["status"] == "passed" and probe["cleanupConfirmed"] is True
    assert all(probe[key] is False for key in ("productAccepted", "browserAccepted", "appleSenderAccepted", "physicalObservationProven", "recording"))
    if session_api:
        assert report["expectBusy"] is False and report["displayManagerBefore"] == "inactive"
        assert probe["sourceIsSynthetic"] is True and probe["platformCallbackIsDouble"] is True
        assert probe["receiverAdvertised"] is False and probe["streamingCallbacks"] == 2
        assert report["hostPlaybackObserved"] is True
        assert len(probe["cycles"]) == 2
        assert [cycle["stopMethod"] for cycle in probe["cycles"]] == ["DELETE", "TTL"]
        assert [cycle["portraitObservedInValidatedIngress"] for cycle in probe["cycles"]] == [True, False]
        for number, cycle in enumerate(probe["cycles"], 1):
            assert cycle["cycle"] == number and cycle["sourceClosed"] is True and cycle["fdReleased"] is True
            assert cycle["output"]["healthy"] is True and min(cycle["output"]["renderedBuffers"].values()) >= 10
            assert cycle["ingress"]["maximumQueuedSamplesPerTrack"] == 2
            assert all(track["receivedFrames"] >= 10 for track in cycle["ingress"]["tracks"].values())
        assert probe["imageSources"] == {str(path.relative_to(ROOT)): digest(path.read_bytes())
            for path in sorted((ROOT / "services/trusted_media_service").rglob("*.py"))}
    elif report["expectBusy"]:
        assert report["displayManagerBefore"] == "active"
        assert probe["busyDenied"] is True and probe["reason"] == "cast_hdmi_display_busy"
        assert "output" not in probe
    else:
        assert report["displayManagerBefore"] == "inactive"
        assert probe["output"]["healthy"] is True and probe["connectorEnabled"] == "enabled"
        assert probe["audioSinkPlaying"] is True
        assert report["hostPlaybackObserved"] is True and report["hostPlaybackObservationCount"] > 0
        assert seconds <= probe["observedPlaybackSeconds"] <= seconds + 5
        assert probe["testTone"] == {"frequencyHz": 440, "initialAmplitude": 0.01,
            "maximumAmplitude": 0.1, "rampSeconds": 5, "systemVolumeChanged": False, "finalAmplitude": 0.1}
        assert min(probe["output"]["renderedBuffers"].values()) >= 10
    assert inspect("container", "teamaibox-" + report["runId"]) is None, "owned container remains"
    image = inspect("image", report["imageId"])
    assert image["Id"] == report["imageId"] and image["Architecture"] == "arm64"
    print(json.dumps({"runId": report["runId"], "strictValidation": "passed", "busyDenialOnly": report["expectBusy"],
                      "productAccepted": False, "evidenceDigest": expected}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    validate(parser.parse_args().evidence)
