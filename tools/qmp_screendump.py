#!/usr/bin/env python3
"""Capture a QEMU guest framebuffer through an existing QMP socket.

The destination is interpreted by QEMU inside its container.  This helper is
deliberately limited to the QMP capabilities handshake and the `screendump`
human monitor command so it cannot mutate guest disks or lifecycle state.
"""

from __future__ import annotations

import argparse
import json
import socket


def receive(stream) -> dict:
    line = stream.readline()
    if not line:
        raise RuntimeError("QMP connection closed")
    return json.loads(line)


def execute(stream, sock: socket.socket, command: dict) -> dict:
    sock.sendall(json.dumps(command, separators=(",", ":")).encode() + b"\r\n")
    while True:
        response = receive(stream)
        if "return" in response or "error" in response:
            return response


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    if not args.output.startswith("/"):
        raise SystemExit("Output path must be absolute")

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(args.timeout)
        sock.connect(args.socket)
        stream = sock.makefile("rb")
        greeting = receive(stream)
        if "QMP" not in greeting:
            raise RuntimeError("Missing QMP greeting")
        capabilities = execute(stream, sock, {"execute": "qmp_capabilities"})
        if "error" in capabilities:
            raise RuntimeError(f"QMP capabilities failed: {capabilities['error']}")
        result = execute(
            stream,
            sock,
            {
                "execute": "human-monitor-command",
                "arguments": {"command-line": f"screendump {args.output}"},
            },
        )
        if "error" in result:
            raise RuntimeError(f"QMP screendump failed: {result['error']}")


if __name__ == "__main__":
    main()
