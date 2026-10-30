#!/usr/bin/env python3
"""Prove a disposable worker cgroup is killed before it can OOM the Spark host."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from typing import Sequence


SAFE_NAME = re.compile(r"^teamaibox-validation-[a-z0-9-]{4,96}-oom$")
SAFE_IMAGE = re.compile(r"^docker\.io/library/node@sha256:[a-f0-9]{64}$")


def run(command: Sequence[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command), check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=timeout,
    )


def probe(name: str, image: str) -> dict[str, object]:
    if not SAFE_NAME.fullmatch(name):
        raise ValueError("unsafe validation container name")
    if not SAFE_IMAGE.fullmatch(image):
        raise ValueError("only the locked Node digest is accepted")
    started = False
    try:
        started = True
        completed = run([
            "docker", "run", "--name", name,
            "--label", f"com.teamaibox.validation-run={name.removeprefix('teamaibox-validation-').removesuffix('-oom')}",
            "--platform", "linux/arm64/v8", "--network", "none", "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", "32", "--memory", "128m", "--memory-swap", "128m",
            image, "node", "-e",
            "const b=[];setInterval(()=>b.push(Buffer.alloc(32*1024*1024,1)),5)",
        ], timeout=45)
        inspected = run([
            "docker", "inspect", "--format",
            "{{.State.OOMKilled}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}",
            name,
        ])
        parts = inspected.stdout.strip().split()
        passed = (
            completed.returncode != 0
            and inspected.returncode == 0
            and parts == ["true", "134217728", "134217728"]
        )
        return {
            "passed": passed,
            "containerOomKilled": parts[:1] == ["true"],
            "memoryLimitBytes": 134_217_728,
            "swapLimitBytes": 134_217_728,
            "hostMutation": False,
        }
    finally:
        if started:
            run(["docker", "rm", "--force", name], timeout=30)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    result = probe(args.name, args.image)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
