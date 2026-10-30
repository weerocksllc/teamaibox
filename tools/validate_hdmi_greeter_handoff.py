"""Verify one authorized handoff and recovery, separately from media success."""
import argparse
import json
from pathlib import Path
import re

from run_trusted_media_hdmi_component import ROOT, canonical, digest, snapshot, ssh


def validate(path, require_output=False):
    report = json.loads(path.read_bytes())
    expected = report.pop("evidenceDigest")
    assert digest(canonical(report)) == expected, "handoff evidence changed"
    run_id = report["runId"]
    assert re.fullmatch(r"hdmi-greeter-handoff-20[0-9]{6}-a[1-9][0-9]*", run_id)
    assert path.name == run_id + ".json"
    assert report["status"] in ("passed", "failed")
    assert report["userAuthorizedTemporaryGreeterStop"] is True
    assert len(report["greeterBefore"]) == 1
    assert report["greeterBefore"][0]["Class"] == "greeter"
    assert report["greeterBefore"][0]["Remote"] == "no"
    assert all(report[key] is True for key in ("watchdogArmed", "displayReleased", "displayRestored",
        "watchdogRemoved", "unrelatedContainersUnchanged"))
    assert all(report[key] is False for key in ("bootConfigChanged", "networkChanged", "modelsStopped", "productAccepted"))
    assert report["beforeContainers"] == report["afterContainers"] == snapshot()
    child_id = report["childRunId"]
    assert re.fullmatch(r"casting-hdmi-component-20[0-9]{6}-a[1-9][0-9]*", child_id)
    child = json.loads((ROOT / "evidence/validation/components" / (child_id + ".json")).read_bytes())
    child_digest = child.pop("evidenceDigest")
    assert digest(canonical(child)) == child_digest == report["childEvidenceDigest"]
    assert child["status"] == report["childStatus"]
    assert child["requestedPlaybackSeconds"] == report["requestedPlaybackSeconds"]
    assert 5 <= report["requestedPlaybackSeconds"] <= 60
    assert report["restoreWatchdogSeconds"] == report["requestedPlaybackSeconds"] + 90
    assert child["cleanupConfirmed"] is True
    assert child["beforeContainers"] == child["afterContainers"] == report["beforeContainers"]
    assert ssh("systemctl is-active display-manager").stdout.decode().strip() == "active"
    timer = "teamaibox-" + run_id + "-restore.timer"
    assert ssh("systemctl is-active " + timer).stdout.decode().strip() in ("inactive", "unknown")
    if require_output:
        from validate_trusted_media_hdmi_component import validate as validate_child
        assert report["status"] == "passed" and report["childExitCode"] == 0
        assert child["expectBusy"] is False
        validate_child(ROOT / "evidence/validation/components" / (child_id + ".json"))
    print(json.dumps({"runId": run_id, "recoveryValidation": "passed", "mediaStatus": child["status"],
        "actualOutputStrictlyValidated": require_output, "productAccepted": False, "evidenceDigest": expected}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--require-output", action="store_true")
    args = parser.parse_args()
    validate(args.evidence, args.require_output)
