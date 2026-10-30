#!/usr/bin/env python3
"""Credential-free SSH transport with an exact, pinned Spark host identity."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import shlex
import subprocess
from typing import Sequence


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class StrictSparkTransportError(RuntimeError):
    pass


_SENSITIVE_KEY = (
    r"(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|"
    r"secret|session|token)"
)


def redact_diagnostic(value: object, limit: int = 2400) -> str:
    """Return a bounded diagnostic with common credential forms removed.

    Evidence may retain this result for troubleshooting, but never raw command
    output.  Cover HTTP auth, JSON, environment/CLI assignments, query strings,
    URI user-info and private-key blocks rather than relying on one key=value
    expression.
    """
    text = str(value)
    text = re.sub(
        r"-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?"
        r"-----END [^-\r\n]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = re.sub(
        r"(?i)\b((?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+)[^\s,;]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        rf"(?i)([\"']?{_SENSITIVE_KEY}[\"']?\s*[:=]\s*)"
        r"(?:[\"'][^\"'\r\n]*[\"']|[^\s,;&]+)",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        rf"(?i)(--{_SENSITIVE_KEY}(?:=|\s+))[^\s]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        rf"(?i)([?&]{_SENSITIVE_KEY}=)[^&#\s]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s/@]+(@)",
        r"\1[REDACTED]\2",
        text,
    )
    return text[-limit:]


def ssh_key_fingerprint(public_key_blob: str) -> str:
    """Return the OpenSSH SHA256 fingerprint for one base64 public-key blob."""
    try:
        raw = base64.b64decode(public_key_blob.encode("ascii"), validate=True)
    except Exception as error:
        raise StrictSparkTransportError("known-host public key is malformed") from error
    return "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")


class StrictSparkTransport:
    """Ignore ambient SSH config and require one exact host key before every call."""

    def __init__(
        self,
        *,
        ssh_target: str,
        address: str,
        host_key_alias: str,
        host_key_algorithm: str,
        host_key_fingerprint: str,
        known_hosts_file: str,
    ) -> None:
        if ssh_target != f"d@{address}" or host_key_alias != address:
            raise StrictSparkTransportError("strict Spark transport target is inconsistent")
        if host_key_algorithm != "ssh-ed25519" or not host_key_fingerprint.startswith("SHA256:"):
            raise StrictSparkTransportError("strict Spark transport key identity is invalid")
        path = Path(known_hosts_file)
        if not path.is_absolute():
            raise StrictSparkTransportError("strict Spark known-hosts path must be absolute")
        self.ssh_target = ssh_target
        self.address = address
        self.host_key_alias = host_key_alias
        self.host_key_algorithm = host_key_algorithm
        self.host_key_fingerprint = host_key_fingerprint
        self.known_hosts_file = path

    @property
    def options(self) -> tuple[str, ...]:
        return (
            "-F", "/dev/null",
            "-o", "BatchMode=yes",
            "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no",
            "-o", "PreferredAuthentications=publickey",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={self.known_hosts_file}",
            "-o", f"HostKeyAlgorithms={self.host_key_algorithm}",
            "-o", f"HostKeyAlias={self.host_key_alias}",
            "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes",
            "-o", "ControlMaster=no",
            "-o", "ProxyCommand=none",
            "-o", "ProxyJump=none",
            "-o", "RequestTTY=no",
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
        )

    @staticmethod
    def _local(command: Sequence[str], timeout: int) -> CommandResult:
        try:
            completed = subprocess.run(
                [str(item) for item in command],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
            stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
            return CommandResult(124, stdout, stderr or "timeout")
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)

    def known_host_fingerprint(self) -> str:
        if not self.known_hosts_file.is_file():
            raise StrictSparkTransportError("strict Spark known-hosts file is missing")
        result = self._local((
            "ssh-keygen", "-F", self.host_key_alias,
            "-f", str(self.known_hosts_file),
        ), 10)
        if result.returncode != 0:
            raise StrictSparkTransportError("strict Spark known-host entry is missing")
        fingerprints: set[str] = set()
        for line in result.stdout.splitlines():
            pieces = line.split()
            if len(pieces) >= 3 and pieces[1] == self.host_key_algorithm:
                fingerprints.add(ssh_key_fingerprint(pieces[2]))
        if fingerprints != {self.host_key_fingerprint}:
            raise StrictSparkTransportError("strict Spark known-host identity is absent or ambiguous")
        return self.host_key_fingerprint

    def run(self, command: Sequence[str], timeout: int = 30) -> CommandResult:
        self.known_host_fingerprint()
        remote_command = shlex.join([str(part) for part in command])
        return self._local((
            "ssh", *self.options, self.ssh_target, remote_command,
        ), timeout)

    def copy(self, local_path: Path, remote_path: str, timeout: int = 60) -> CommandResult:
        self.known_host_fingerprint()
        return self._local((
            "scp", "-q", *self.options, str(local_path),
            f"{self.ssh_target}:{remote_path}",
        ), timeout)

    def verify_machine(self, *, hostname: str, machine_id_sha256: str) -> dict[str, object]:
        result = self.run((
            "sh", "-ceu", "printf '%s|%s' \"$(hostname)\" \"$(cat /etc/machine-id)\"",
        ), 30)
        if result.returncode != 0:
            raise StrictSparkTransportError("strict Spark machine identity query failed")
        pieces = result.stdout.strip().split("|")
        if len(pieces) != 2:
            raise StrictSparkTransportError("strict Spark machine identity is malformed")
        observed_digest = "sha256:" + hashlib.sha256(pieces[1].encode("utf-8")).hexdigest()
        if pieces[0] != hostname or observed_digest != machine_id_sha256:
            raise StrictSparkTransportError("strict Spark machine identity drifted")
        return {
            "ssh": self.ssh_target,
            "address": self.address,
            "hostname": pieces[0],
            "machineIdSha256": observed_digest,
            "hostKeyAlgorithm": self.host_key_algorithm,
            "hostKeyFingerprint": self.known_host_fingerprint(),
            "hostKeyAlias": self.host_key_alias,
            "knownHostsFile": str(self.known_hosts_file),
            "batchMode": True,
            "strictHostKeyChecking": True,
            "passwordAuthentication": False,
            "agentForwarding": False,
            "ambientSshConfigIgnored": True,
            "proxyDisabled": True,
        }
