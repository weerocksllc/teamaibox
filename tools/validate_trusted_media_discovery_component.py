"""Independent strict checks of the bounded discovery component only."""
import argparse
import json
from pathlib import Path
import re

from run_trusted_media_fanout_component import ROOT, digest, canonical, inspect
from run_trusted_media_discovery_component import SOURCES


def validate(path):
    report = json.loads(path.read_text())
    claimed = report.pop("evidenceDigest")
    assert claimed == digest(canonical(report)), "evidence digest mismatch"
    assert re.fullmatch(r"casting-private-discovery-20[0-9]{6}-a[1-9][0-9]*", report["runId"])
    assert report["status"] == "passed" and report["returnCode"] == 0 and report["cleanupConfirmed"] is True
    assert report["sources"] == [{"path": p, "sha256": digest((ROOT / p).read_bytes())} for p in SOURCES]
    assert report["architecture"] == "arm64"
    for key in ("userLanAdvertised", "hostPortsPublished", "gpuUsed", "hostBusMounted", "productAccepted", "appleSenderAccepted"):
        assert report[key] is False
    policy = report["containerPolicy"]
    assert policy == {"imageId": report["imageId"], "readOnly": True, "capDrop": ["ALL"], "user": "65532:65532",
        "networkInternal": True, "publishedPorts": {}, "deviceRequests": None, "oomKilled": False}
    assert report["facts"] == {"privateDnsSdObserved": True, "hostBusMounted": False, "nonRootUid": 65532,
        "survivedRequestThreadExit": True, "serviceParentDeathProtectionObserved": True,
        "nativeReceiverAdvertisedInIsolatedNetwork": True, "advertisementWithdrawn": True,
        "ownedChildrenReaped": 3, "ephemeralDiscoveryStateRemoved": True, "senderPaired": False,
        "appleSenderAccepted": False, "productAccepted": False}
    image = inspect("image", report["imageId"])
    assert image and image["Architecture"] == "arm64" and image["Config"]["User"] == "65532:65532"
    assert inspect("container", "teamaibox-" + report["runId"]) is None
    assert inspect("network", "teamaibox-net-" + report["runId"]) is None
    return {"valid": True, "runId": report["runId"], "evidenceDigest": claimed, "productAccepted": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    print(json.dumps(validate(parser.parse_args().evidence)))
