#!/usr/bin/env python3
"""Non-booting product-bundle check. Does not advertise a ready phone service."""
import json
from pathlib import Path
import shutil
import sys


def main():
    root = Path("/opt/cuttlefish")
    lock = json.loads((root / "teamaibox-inputs.json").read_text())
    for executable in ("launch_cvd", "assemble_cvd", "stop_cvd", "adb", "crosvm", "webRTC", "webrtc_operator"):
        path = root / "bin" / executable
        if not path.is_file(): raise ValueError("required Cuttlefish binary missing")
    if shutil.which("chromium") or shutil.which("google-chrome"):
        raise ValueError("test browser must not enter product runtime")
    if (root / "usr/share/webrtc/certs").exists(): raise ValueError("sample TLS keys included")
    print(json.dumps({"schemaVersion":1,"buildId":lock["buildId"],"kind":"cuttlefish-product-bundle",
        "firstProfile":lock["firstProfile"],"androidStarted":False,"runtimeServiceReady":False,
        "requires":"managed Node Agent, verified encrypted private storage and scoped media credentials"}))


if __name__ == "__main__":
    if len(sys.argv) != 1: raise SystemExit("this command accepts no guest or shell parameters")
    main()
