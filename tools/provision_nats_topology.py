#!/usr/bin/env python3
"""Create or verify the versioned JetStream topology over the NATS protocol."""

from __future__ import annotations

import argparse
import json
import pathlib
import secrets
import socket
from typing import Any, Mapping, Sequence


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_TOPOLOGY = ROOT / "packages" / "event-bus" / "topology.v1.json"


class NatsError(RuntimeError):
    pass


class NatsConnection:
    def __init__(self, host: str, port: int, token: str, timeout: float = 5.0) -> None:
        self._socket = socket.create_connection((host, port), timeout=timeout)
        self._socket.settimeout(timeout)
        self._reader = self._socket.makefile("rb")
        info = self._read_protocol_line()
        if not info.startswith(b"INFO "):
            self.close()
            raise NatsError("server did not send a NATS INFO message")
        connect = json.dumps(
            {
                "verbose": False,
                "pedantic": True,
                "auth_token": token,
                "name": "teamaibox-topology-provisioner",
                "lang": "python",
                "version": "0.1.0",
                "protocol": 1,
            },
            separators=(",", ":"),
        ).encode()
        self._send(b"CONNECT " + connect + b"\r\nPING\r\n")
        self._wait_for_pong()

    def close(self) -> None:
        try:
            self._reader.close()
        finally:
            self._socket.close()

    def __enter__(self) -> "NatsConnection":
        return self

    def __exit__(self, _kind: object, _value: object, _traceback: object) -> None:
        self.close()

    def _send(self, value: bytes) -> None:
        self._socket.sendall(value)

    def _read_protocol_line(self) -> bytes:
        line = self._reader.readline()
        if not line:
            raise NatsError("NATS connection closed unexpectedly")
        if not line.endswith(b"\r\n"):
            raise NatsError("invalid NATS protocol line")
        return line[:-2]

    def _wait_for_pong(self) -> None:
        while True:
            line = self._read_protocol_line()
            if line == b"PONG":
                return
            if line == b"PING":
                self._send(b"PONG\r\n")
                continue
            if line.startswith(b"-ERR"):
                raise NatsError("NATS server rejected the connection")
            if line.startswith((b"+OK", b"INFO ")):
                continue
            raise NatsError("unexpected NATS protocol response while connecting")

    def request(self, subject: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        inbox = "_INBOX.TAIB." + secrets.token_hex(16)
        sid = secrets.randbelow(2_000_000_000) + 1
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        command = (
            f"SUB {inbox} {sid}\r\n"
            f"UNSUB {sid} 1\r\n"
            f"PUB {subject} {inbox} {len(encoded)}\r\n"
        ).encode() + encoded + b"\r\nPING\r\n"
        self._send(command)
        while True:
            line = self._read_protocol_line()
            if line == b"PING":
                self._send(b"PONG\r\n")
                continue
            if line == b"PONG":
                # A flush PONG can precede an asynchronously produced
                # JetStream API reply. The one-message subscription is the
                # request completion boundary, not the PONG ordering.
                continue
            if line.startswith(b"-ERR"):
                raise NatsError("NATS server rejected a JetStream request")
            if line.startswith((b"+OK", b"INFO ")):
                continue
            if line.startswith(b"MSG "):
                parts = line.split()
                if len(parts) not in {4, 5}:
                    raise NatsError("invalid NATS MSG response")
                size = int(parts[-1])
                body = self._reader.read(size)
                if len(body) != size or self._reader.read(2) != b"\r\n":
                    raise NatsError("truncated NATS MSG response")
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise NatsError("JetStream response is not an object")
                return value
            raise NatsError("unexpected NATS protocol response")


def desired_stream_config(topology: Mapping[str, Any], stream: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "name": stream["name"],
        "subjects": stream["subjects"],
        "retention": stream["retention"],
        "storage": stream["storage"],
        "max_age": stream["maxAgeSeconds"] * 1_000_000_000,
        "max_bytes": stream["maxBytes"],
        "duplicate_window": stream["duplicateWindowSeconds"] * 1_000_000_000,
        "discard": stream["discard"],
        "num_replicas": topology["singleNodeReplicas"],
    }


def _drift(desired: Mapping[str, Any], actual: Mapping[str, Any]) -> list[str]:
    fields = (
        "name",
        "subjects",
        "retention",
        "storage",
        "max_age",
        "max_bytes",
        "duplicate_window",
        "discard",
        "num_replicas",
    )
    return [field for field in fields if actual.get(field) != desired.get(field)]


def reconcile(connection: NatsConnection, topology: Mapping[str, Any], apply: bool) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for stream in topology["streams"]:
        desired = desired_stream_config(topology, stream)
        name = stream["name"]
        info = connection.request(f"$JS.API.STREAM.INFO.{name}", {})
        error = info.get("error")
        if isinstance(error, Mapping) and error.get("code") == 404:
            if not apply:
                raise NatsError(f"required stream is missing: {name}")
            created = connection.request(f"$JS.API.STREAM.CREATE.{name}", desired)
            creation_error = created.get("error")
            if isinstance(creation_error, Mapping):
                code = creation_error.get("err_code", creation_error.get("code", "unknown"))
                description = str(creation_error.get("description", "unspecified"))[:512]
                raise NatsError(
                    f"JetStream refused stream creation {name}: {code} {description}"
                )
            actual = created.get("config")
            if not isinstance(actual, Mapping):
                raise NatsError(f"JetStream omitted created stream config: {name}")
            drift = _drift(desired, actual)
            if drift:
                raise NatsError(f"created stream differs for {name}: {','.join(drift)}")
            results.append({"name": name, "status": "created"})
            continue
        if error:
            raise NatsError(f"JetStream info failed for stream: {name}")
        actual = info.get("config")
        if not isinstance(actual, Mapping):
            raise NatsError(f"JetStream omitted stream config: {name}")
        drift = _drift(desired, actual)
        if drift:
            raise NatsError(f"stream configuration drift for {name}: {','.join(drift)}")
        results.append({"name": name, "status": "verified"})
    return results


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4222)
    parser.add_argument("--token-file", required=True, type=pathlib.Path)
    parser.add_argument("--topology", type=pathlib.Path, default=DEFAULT_TOPOLOGY)
    parser.add_argument("--apply", action="store_true", help="create missing streams; never updates existing streams")
    args = parser.parse_args(argv)
    try:
        token = args.token_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        parser.error(f"cannot read token file: {error}")
    if not token:
        parser.error("token file is empty")
    topology = json.loads(args.topology.read_text(encoding="utf-8"))
    try:
        with NatsConnection(args.host, args.port, token) as connection:
            results = reconcile(connection, topology, apply=args.apply)
    except (NatsError, OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps({"mode": "apply" if args.apply else "check", "streams": results}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
