#!/usr/bin/env python3
"""Run a public download container through short, resumable SSH control calls."""

from __future__ import annotations

import json
from pathlib import Path
import shlex
import subprocess
import time
from typing import Sequence


class RemoteContainerError(RuntimeError):
    pass


def _remote(root: Path, host: str, arguments: Sequence[str], timeout: int = 90) -> str:
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
         shlex.join([str(item) for item in arguments])],
        cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        timeout=timeout, check=False,
    )
    if result.returncode:
        detail = " | ".join((result.stdout + "\n" + result.stderr).splitlines()[-12:])[:1200]
        raise RemoteContainerError("remote container control failed: " + detail)
    return result.stdout


def run_resumable_download(
    *, root: Path, host: str, run_id: str, name_prefix: str,
    docker_arguments: Sequence[str], attempts: int = 5,
    attempt_timeout_seconds: int = 10800, poll_seconds: int = 15,
) -> dict[str, object]:
    """Run detached attempts against one run-owned volume without a long-lived SSH pipe."""
    if attempts < 1 or not run_id or not name_prefix:
        raise RemoteContainerError("invalid resumable download identity")
    failures: list[dict[str, object]] = []
    for attempt in range(1, attempts + 1):
        name = f"{name_prefix}-{attempt}"
        existing = _remote(root, host, ("sudo", "docker", "ps", "--all", "--quiet",
            "--filter", "name=^/" + name + "$"), 30).strip()
        if existing:
            raise RemoteContainerError("run-owned download container already exists: " + name)
        container_id = _remote(root, host, ("sudo", "docker", "run", "--detach",
            "--name", name, "--label", "com.teamaibox.managed=true", "--label",
            "com.teamaibox.purpose=model-download", "--label", "com.teamaibox.run-id=" + run_id,
            *docker_arguments), 120).strip()
        if len(container_id) < 12:
            raise RemoteContainerError("download container did not return an identity")
        deadline = time.monotonic() + attempt_timeout_seconds
        consecutive_control_failures = 0
        state: dict[str, object] | None = None
        while time.monotonic() < deadline:
            try:
                raw = _remote(root, host, ("sudo", "docker", "inspect", "--format",
                    "{{json .State}}", name), 45).strip()
                state = json.loads(raw)
                consecutive_control_failures = 0
            except (RemoteContainerError, json.JSONDecodeError) as error:
                consecutive_control_failures += 1
                if consecutive_control_failures >= 6:
                    state = {"Running": False, "ExitCode": -1,
                        "Error": "six consecutive short SSH control failures: " + type(error).__name__}
                    break
                time.sleep(poll_seconds)
                continue
            if state.get("Running") is False:
                break
            time.sleep(poll_seconds)
        if state is None or state.get("Running") is True:
            try:
                _remote(root, host, ("sudo", "docker", "stop", "--time", "30", name), 90)
            except RemoteContainerError:
                pass
            state = {"Running": False, "ExitCode": -2, "Error": "attempt timeout"}
        try:
            logs = _remote(root, host, ("sudo", "docker", "logs", "--tail", "40", name), 60)
        except RemoteContainerError:
            logs = ""
        try:
            _remote(root, host, ("sudo", "docker", "rm", "--force", name), 90)
        except RemoteContainerError as error:
            raise RemoteContainerError("exact download-container cleanup failed: " + name) from error
        exit_code = int(state.get("ExitCode", -1))
        if exit_code == 0:
            return {"attemptsUsed": attempt, "containerId": container_id,
                "lastLogSha256Retained": False}
        failures.append({"attempt": attempt, "exitCode": exit_code,
            "error": str(state.get("Error") or "container exited")[:300],
            "logTail": " | ".join(logs.splitlines()[-8:])[:800]})
        if attempt < attempts:
            time.sleep(min(60, 5 * 2 ** (attempt - 1)))
    detail = failures[-1] if failures else {"error": "no attempt executed"}
    raise RemoteContainerError("resumable download exhausted exact attempts: " + str(detail))
