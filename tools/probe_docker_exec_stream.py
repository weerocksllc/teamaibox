#!/usr/bin/env python3
"""Read the fixed VNC greeting from Docker's exec hijack transport.

This diagnostic intentionally prints only the public RFB protocol greeting and
its framing bytes. It never reads framebuffer, keyboard, account, or disk data.
"""

from __future__ import annotations

import argparse
import json
import socket


def receive_headers(connection: socket.socket) -> bytes:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            raise RuntimeError("docker_upgrade_closed")
        data.extend(chunk)
        if len(data) > 65536:
            raise RuntimeError("docker_upgrade_headers_too_large")
    headers, remainder = bytes(data).split(b"\r\n\r\n", 1)
    if b" 101 " not in headers.split(b"\r\n", 1)[0]:
        raise RuntimeError("docker_upgrade_rejected")
    return remainder


def docker_request(path: str, payload: dict[str, object]) -> dict[str, object]:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect("/var/run/docker.sock")
    request = (
        f"POST {path} HTTP/1.1\r\nHost: docker\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(raw)}\r\nConnection: close\r\n\r\n"
    ).encode() + raw
    connection.sendall(request)
    response = bytearray()
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        response.extend(chunk)
    connection.close()
    headers, body = bytes(response).split(b"\r\n\r\n", 1)
    if b" 201 " not in headers.split(b"\r\n", 1)[0]:
        raise RuntimeError("docker_exec_create_rejected")
    return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--port", choices=("5900",), default="5900")
    args = parser.parse_args()
    program = (
        "import socket,sys;"
        "s=socket.create_connection(('127.0.0.1',int(sys.argv[1])),3);"
        "sys.stdout.buffer.write(s.recv(12));sys.stdout.buffer.flush();s.close()"
    )
    created = docker_request(
        f"/containers/{args.container}/exec",
        {
            "AttachStdin": False,
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": False,
            "Privileged": False,
            "User": "10001:10001",
            "Cmd": ["/usr/bin/python3", "-u", "-c", program, args.port],
        },
    )
    exec_id = created.get("Id")
    if not isinstance(exec_id, str) or len(exec_id) != 64:
        raise RuntimeError("docker_exec_id_invalid")

    raw = b'{"Detach":false,"Tty":false}'
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    connection.connect("/var/run/docker.sock")
    request = (
        f"POST /exec/{exec_id}/start HTTP/1.1\r\nHost: docker\r\n"
        "Content-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n"
        f"Content-Length: {len(raw)}\r\n\r\n"
    ).encode() + raw
    connection.sendall(request)
    remainder = receive_headers(connection)
    while len(remainder) < 20:
        chunk = connection.recv(20 - len(remainder))
        if not chunk:
            break
        remainder += chunk
    connection.close()
    print(json.dumps({"length": len(remainder), "hex": remainder.hex(), "ascii": repr(remainder)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
