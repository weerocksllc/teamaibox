#!/usr/bin/env python3
"""Minimal root helper for one run-scoped disposable LUKS2 Web-unlock volume.

The helper deliberately has no caller-controlled device, mapper, mount, or
command fields.  A validated run identity deterministically selects one sparse
regular file below /tmp; active block devices can never be addressed through
this protocol.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import struct
import subprocess
from typing import Any, Sequence


RUN_ID = re.compile(r"^luks-unlock-integration-[0-9]{8}-[a-z0-9][a-z0-9-]{1,31}$")
ROOT_PREFIX = "/tmp/teamaibox-luks-unlock-integration-"
MAPPER_PREFIX = "teamaibox-luks-unlock-"
MAX_PAYLOAD = 16_384


class UnlockHelperError(RuntimeError):
    pass


def configuration(run_id: str) -> dict[str, Any]:
    if RUN_ID.fullmatch(run_id) is None:
        raise UnlockHelperError("unlock helper run identity is invalid")
    suffix = run_id.removeprefix("luks-unlock-integration-")
    root = Path(ROOT_PREFIX + suffix)
    mapper = MAPPER_PREFIX + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:20]
    if root.parent != Path("/tmp") or not str(root).startswith(ROOT_PREFIX) or "/" in mapper:
        raise UnlockHelperError("unlock helper target escaped its disposable boundary")
    return {
        "root": root,
        "image": root / "volume.img",
        "mount": root / "mount",
        "socket": root / "helper.sock",
        "mapper": mapper,
        "mapped": Path("/dev/mapper") / mapper,
    }


class CommandRunner:
    def run(
        self,
        arguments: Sequence[str],
        *,
        input_bytes: bytearray | None = None,
        timeout: int = 120,
        check: bool = True,
    ) -> subprocess.CompletedProcess[bytes]:
        try:
            result = subprocess.run(
                list(arguments), input=input_bytes, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise UnlockHelperError(f"bounded command timed out: {arguments[0]}") from error
        if check and result.returncode != 0:
            raise UnlockHelperError(f"bounded command failed: {arguments[0]}")
        return result


class DisposableLuksVolume:
    def __init__(self, run_id: str, runner: CommandRunner | None = None):
        self.paths = configuration(run_id)
        self.runner = runner or CommandRunner()

    def validate(self) -> None:
        image, mount = self.paths["image"], self.paths["mount"]
        if not image.is_file() or image.is_symlink() or not mount.is_dir() or mount.is_symlink():
            raise UnlockHelperError("disposable LUKS2 paths are missing or unsafe")
        mode = image.stat().st_mode
        if not stat.S_ISREG(mode) or image.stat().st_size < 512 * 1024 * 1024:
            raise UnlockHelperError("disposable LUKS2 backing file is invalid")
        self.runner.run(("cryptsetup", "isLuks", "--type", "luks2", str(image)))

    def status(self) -> dict[str, Any]:
        mapped = self.paths["mapped"].exists()
        mounted = self.runner.run(("mountpoint", "-q", str(self.paths["mount"])), check=False).returncode == 0
        if mounted and mapped:
            state = "unlocked"
        elif not mounted and not mapped:
            state = "locked"
        else:
            state = "error"
        return {"state": state, "mode": "web_passphrase"}

    def unlock(self, passphrase: bytearray) -> dict[str, Any]:
        if not passphrase or len(passphrase) > MAX_PAYLOAD or b"\0" in passphrase:
            return {"accepted": False}
        before = self.status()["state"]
        if before == "unlocked":
            return {"accepted": True}
        if before != "locked":
            return {"accepted": False}
        opened = False
        try:
            result = self.runner.run((
                "cryptsetup", "open", "--type", "luks2", "--key-file", "-",
                str(self.paths["image"]), self.paths["mapper"],
            ), input_bytes=passphrase, timeout=300, check=False)
            if result.returncode != 0:
                return {"accepted": False}
            opened = True
            self.runner.run((
                "mount", "-o", "nodev,nosuid,noexec", str(self.paths["mapped"]),
                str(self.paths["mount"]),
            ))
            opened = False
            return {"accepted": self.status()["state"] == "unlocked"}
        except UnlockHelperError:
            return {"accepted": False}
        finally:
            if opened:
                self.runner.run(("cryptsetup", "close", self.paths["mapper"]), check=False)


def peer_uid(connection: socket.socket) -> int:
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    return uid


def read_exact(connection: socket.socket, size: int) -> bytearray:
    value = bytearray()
    while len(value) < size:
        chunk = connection.recv(size - len(value))
        if not chunk:
            raise UnlockHelperError("unlock helper request ended early")
        value.extend(chunk)
    return value


def handle(connection: socket.socket, volume: DisposableLuksVolume, allowed_uid: int) -> None:
    payload = bytearray()
    try:
        if peer_uid(connection) != allowed_uid:
            raise UnlockHelperError("unlock helper peer is not authorized")
        header = read_exact(connection, 5)
        operation, size = header[0], int.from_bytes(header[1:], "big")
        header[:] = b"\0" * len(header)
        if size > MAX_PAYLOAD or (operation == 1 and size != 0) or operation not in {1, 2}:
            raise UnlockHelperError("unlock helper request is invalid")
        payload = read_exact(connection, size) if size else bytearray()
        result = volume.status() if operation == 1 else volume.unlock(payload)
    except Exception:
        result = {"state": "error"}
    finally:
        payload[:] = b"\0" * len(payload)
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 4096:
        encoded = b'{"state":"error"}'
    connection.sendall(encoded)


def serve(run_id: str, *, allowed_uid: int = 1000, allowed_gid: int = 1000) -> None:
    if allowed_uid < 1 or allowed_gid < 1:
        raise UnlockHelperError("unlock helper peer identity is invalid")
    volume = DisposableLuksVolume(run_id)
    volume.validate()
    path = volume.paths["socket"]
    if path.exists() or path.is_symlink():
        raise UnlockHelperError("unlock helper socket already exists")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stopping = False

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        server.close()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.bind(str(path))
        os.chown(path, allowed_uid, allowed_gid)
        os.chmod(path, 0o600)
        server.listen(8)
        server.settimeout(1.0)
        while not stopping:
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                if stopping:
                    break
                raise
            with connection:
                connection.settimeout(10)
                handle(connection, volume, allowed_uid)
    finally:
        server.close()
        if path.exists() and path.is_socket() and str(path).startswith(ROOT_PREFIX):
            path.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--allowed-uid", type=int, default=1000)
    parser.add_argument("--allowed-gid", type=int, default=1000)
    args = parser.parse_args(argv)
    serve(args.run_id, allowed_uid=args.allowed_uid, allowed_gid=args.allowed_gid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
