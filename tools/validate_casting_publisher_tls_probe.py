"""Strictly validate a synthetic rejection or publishing probe, not Apple UX."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def sha(value): return "sha256:" + hashlib.sha256(value).hexdigest()
def validate(path):
    v = json.loads(Path(path).read_bytes())
    unsigned = {k: value for k, value in v.items() if k != "evidenceDigest"}
    assert v["evidenceDigest"] == sha(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode())
    assert all(sha((ROOT/name).read_bytes()) == digest for name, digest in v["sources"].items())
    assert not v.get("errorClass") and v["before"]["idle"] and v["after"]["idle"]
    assert v["before"]["containers"] == v["after"]["containers"]
    assert v["productAccepted"] is False and v["browserAccepted"] is False
    result = v["result"]
    assert result["runId"] == v["runId"] and result["trustMode"] == v["mode"]
    assert result["syntheticOnly"] and result["roomCleaned"] and not result.get("cleanupFailed")
    assert result["receiverAdvertised"] is False and result["appleSenderAccepted"] is False
    if v["mode"] == "missing":
        assert v["status"] == result["status"] == "failed"
        assert result["sfuParticipants"] == 0 and result["sfuTracks"] == []
        assert any(e.get("certificate") for e in result["errors"])
        classification = "missing-ca-reproduced"
    else:
        assert v["status"] == result["status"] == "passed" and not result["errors"]
        assert result["failureCode"] is None and result["elapsedSeconds"] >= v["duration"] - 0.1
        assert result["sfuParticipants"] == 1 and result["sfuTracks"] == ["AUDIO", "VIDEO"]
        s = result["publisher"]
        assert s["healthy"] and s["activeSfuConnections"] == s["activeVideoEncoders"] == 1
        assert min(s["encodedVideoBuffers"], s["encodedAudioBuffers"]) >= 50
        classification = "synthetic-publisher-passed"
    return dict(runId=v["runId"], strictValidation="passed", classification=classification,
                browserAccepted=False, appleSenderAccepted=False, evidenceDigest=v["evidenceDigest"])
if __name__ == "__main__":
    p = argparse.ArgumentParser(); p.add_argument("--evidence", required=True)
    print(json.dumps(validate(p.parse_args().evidence)))
