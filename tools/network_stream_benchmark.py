#!/usr/bin/env python3
"""Run a bounded, dependency-free TCP stream benchmark between lab peers.

The protocol transfers generated zero-filled chunks and reports only direction,
byte count, duration, and throughput. It never emits peer addresses or payload
content. This is a transport baseline, not a replacement for a full iperf3/RDMA
qualification campaign.
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import time
from typing import Any


MAGIC = b"TAIBNET1"
ACK = b"K"
CHUNK_BYTES = 1024 * 1024
DEFAULT_BYTES = 512 * 1024 * 1024
DEFAULT_PORT = 43891
DEFAULT_TIMEOUT = 30.0
MAX_BYTES = 4 * 1024 * 1024 * 1024


def _result(direction: str, byte_count: int, elapsed: float) -> dict[str, Any]:
    safe_elapsed = max(elapsed, 1e-9)
    return {
        "direction": direction,
        "bytes": byte_count,
        "seconds": round(safe_elapsed, 6),
        "megabits_per_second": round(byte_count * 8.0 / 1_000_000.0 / safe_elapsed, 2),
    }


def _recv_exact(connection: socket.socket, count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise ConnectionError("peer closed before the protocol message completed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_bytes(connection: socket.socket, byte_count: int) -> None:
    chunk = bytes(min(CHUNK_BYTES, byte_count))
    remaining = byte_count
    while remaining:
        size = min(len(chunk), remaining)
        connection.sendall(chunk[:size])
        remaining -= size


def _receive_bytes(connection: socket.socket, byte_count: int) -> None:
    remaining = byte_count
    while remaining:
        chunk = connection.recv(min(CHUNK_BYTES, remaining))
        if not chunk:
            raise ConnectionError("peer closed before the bounded transfer completed")
        remaining -= len(chunk)


def run_server(bind: str, port: int, connections: int, timeout: float) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.settimeout(timeout)
        listener.bind((bind, port))
        listener.listen(1)
        for _ in range(connections):
            connection, _peer = listener.accept()
            with connection:
                connection.settimeout(timeout)
                header = _recv_exact(connection, len(MAGIC) + 1 + 8)
                if header[: len(MAGIC)] != MAGIC:
                    raise ValueError("invalid benchmark protocol magic")
                direction = header[len(MAGIC) : len(MAGIC) + 1]
                byte_count = struct.unpack("!Q", header[-8:])[0]
                if byte_count < 1 or byte_count > MAX_BYTES:
                    raise ValueError("requested transfer is outside the server safety bound")
                started = time.monotonic()
                if direction == b"D":
                    _send_bytes(connection, byte_count)
                    connection.shutdown(socket.SHUT_WR)
                elif direction == b"U":
                    _receive_bytes(connection, byte_count)
                    connection.sendall(ACK)
                else:
                    raise ValueError("invalid benchmark direction")
                reports.append(
                    _result("server-send" if direction == b"D" else "server-receive", byte_count, time.monotonic() - started)
                )
    return reports


def _client_transfer(host: str, port: int, byte_count: int, timeout: float, direction: bytes) -> dict[str, Any]:
    with socket.create_connection((host, port), timeout=timeout) as connection:
        connection.settimeout(timeout)
        connection.sendall(MAGIC + direction + struct.pack("!Q", byte_count))
        started = time.monotonic()
        if direction == b"D":
            _receive_bytes(connection, byte_count)
            label = "download"
        else:
            _send_bytes(connection, byte_count)
            if _recv_exact(connection, len(ACK)) != ACK:
                raise ValueError("invalid server acknowledgement")
            label = "upload"
        return _result(label, byte_count, time.monotonic() - started)


def run_client(host: str, port: int, byte_count: int, timeout: float) -> list[dict[str, Any]]:
    return [
        _client_transfer(host, port, byte_count, timeout, b"D"),
        _client_transfer(host, port, byte_count, timeout, b"U"),
    ]


def _bounded_bytes(value: str) -> int:
    parsed = int(value)
    if parsed < 1 or parsed > MAX_BYTES:
        raise argparse.ArgumentTypeError(f"bytes must be between 1 and {MAX_BYTES}")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="mode", required=True)

    server = subparsers.add_parser("server")
    server.add_argument("--bind", default="0.0.0.0")
    server.add_argument("--port", type=int, default=DEFAULT_PORT)
    server.add_argument("--connections", type=int, default=2, choices=range(1, 9))
    server.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)

    client = subparsers.add_parser("client")
    client.add_argument("--host", required=True)
    client.add_argument("--port", type=int, default=DEFAULT_PORT)
    client.add_argument("--bytes", type=_bounded_bytes, default=DEFAULT_BYTES)
    client.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)

    args = parser.parse_args()
    if args.mode == "server":
        reports = run_server(args.bind, args.port, args.connections, args.timeout)
    else:
        reports = run_client(args.host, args.port, args.bytes, args.timeout)
    print(json.dumps({"mode": args.mode, "results": reports}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

