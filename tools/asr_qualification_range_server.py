#!/usr/bin/env python3
"""Serve one qualification file with strict HEAD and single-range GET support."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxQualification/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_HEAD(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_response(200); self.send_header("content-length", "0"); self.end_headers(); return
        self._serve(False)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_response(200); self.send_header("content-length", "0"); self.end_headers(); return
        self._serve(True)

    def _serve(self, include_body: bool) -> None:
        if self.path != "/source.wav":
            self.send_error(404); return
        source: Path = self.server.source  # type: ignore[attr-defined]
        size = source.stat().st_size
        start, end, status = 0, size - 1, 200
        header = self.headers.get("range")
        if header:
            match = re.fullmatch(r"bytes=([0-9]+)-([0-9]*)", header)
            if match is None:
                self.send_error(416); return
            start = int(match.group(1)); end = int(match.group(2)) if match.group(2) else size - 1
            if start >= size or end < start or end >= size:
                self.send_error(416); return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("accept-ranges", "bytes")
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(length))
        if status == 206:
            self.send_header("content-range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not include_body:
            return
        with source.open("rb") as stream:
            stream.seek(start)
            remaining = length
            while remaining:
                chunk = stream.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk); remaining -= len(chunk)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    source = args.file.resolve(strict=True)
    if not source.is_file() or source.name != "source.wav" or not 1024 < source.stat().st_size < 64 * 1024 * 1024:
        raise SystemExit("qualification source boundary is invalid")
    if not 1024 <= args.port <= 65535:
        raise SystemExit("qualification port is invalid")
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.source = source  # type: ignore[attr-defined]
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
