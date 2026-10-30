#!/usr/bin/env python3
"""Resume an exact reviewed Hugging Face snapshot without installing host tools."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--files-json", required=True)
    args = parser.parse_args()
    files = json.loads(args.files_json)
    if not isinstance(files, list) or not files or any(
        not isinstance(name, str) or "/" in name or name in {".", ".."} for name in files
    ):
        raise ValueError("reviewed file allowlist is invalid")
    args.output.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/{args.repository}/resolve/{args.revision}/"
    for name in files:
        path = args.output / name
        start = path.stat().st_size if path.exists() else 0
        request = urllib.request.Request(base + name)
        if start:
            request.add_header("Range", f"bytes={start}-")
        with urllib.request.urlopen(request, timeout=300) as response:
            append = start > 0 and response.status == 206
            with path.open("ab" if append else "wb") as output:
                while block := response.read(8 * 1024 * 1024):
                    output.write(block)
        print(json.dumps({"file": name, "bytes": path.stat().st_size}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
