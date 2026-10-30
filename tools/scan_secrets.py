#!/usr/bin/env python3
"""Fail on high-confidence plaintext credential patterns in repository files."""

from __future__ import annotations

import argparse
import math
import os
import pathlib
import re
import subprocess
from collections import Counter
from typing import Iterable, Sequence


ROOT = pathlib.Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 2 * 1024 * 1024
HIGH_CONFIDENCE = {
    "aws_access_key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "github_token": re.compile(rb"gh[pousr]_[A-Za-z0-9]{36,255}"),
    "openai_key": re.compile(rb"sk-[A-Za-z0-9]{20,255}"),
    # A quoted header alone is commonly a parser/negative-test marker, not key
    # material. Real PEM (including escaped PEM in JSON/source) starts a line
    # after the header. Keep detecting truncated headers followed by a newline.
    "private_key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?=\r?\n|\\(?:r\\)?n)"),
}
ASSIGNMENT = re.compile(
    rb"(?i)(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)"
    rb"\s*[:=]\s*[\"']([A-Za-z0-9_./+=:-]{24,512})[\"']"
)
SAFE_PLACEHOLDERS = (b"example", b"placeholder", b"redacted", b"test-only", b"not-a-credential")
SELF = pathlib.PurePosixPath("tools/scan_secrets.py")


class SecretScanError(ValueError):
    pass


def shannon_entropy(value: bytes) -> float:
    if not value:
        return 0.0
    counts = Counter(value)
    return -sum((count / len(value)) * math.log2(count / len(value)) for count in counts.values())


def repository_files(root: pathlib.Path = ROOT) -> list[pathlib.Path]:
    completed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise SecretScanError("git file inventory failed")
    output = []
    for raw in completed.stdout.split(b"\0"):
        if not raw:
            continue
        relative = pathlib.PurePosixPath(raw.decode("utf-8"))
        if relative.is_absolute() or ".." in relative.parts:
            raise SecretScanError("unsafe repository path returned by git")
        candidate = root / relative
        if candidate.is_file() and not candidate.is_symlink():
            output.append(candidate)
    return sorted(output)


def all_files(root: pathlib.Path = ROOT) -> list[pathlib.Path]:
    excluded = {".git", ".runtime", "node_modules", ".pnpm-store", "__pycache__", "build", "dist"}
    output = []
    # Prune the existing exclusions before traversal. Filtering rglob results
    # still walks dependency/build trees even though none of their files are read.
    for directory, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories
                          if name not in excluded and not (pathlib.Path(directory) / name).is_symlink()]
        for name in filenames:
            candidate = pathlib.Path(directory) / name
            if name not in excluded and candidate.is_file() and not candidate.is_symlink():
                output.append(candidate)
    return sorted(output)


def scan_paths(paths: Iterable[pathlib.Path], root: pathlib.Path = ROOT) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []
    for filename in paths:
        try:
            relative = filename.resolve().relative_to(root.resolve())
        except ValueError as error:
            raise SecretScanError("scan path is outside the repository") from error
        if pathlib.PurePosixPath(relative.as_posix()) == SELF:
            continue
        size = filename.stat().st_size
        if size > MAX_FILE_BYTES:
            continue
        content = filename.read_bytes()
        if b"\0" in content:
            continue
        for label, pattern in HIGH_CONFIDENCE.items():
            for match in pattern.finditer(content):
                findings.append({
                    "path": relative.as_posix(),
                    "line": content.count(b"\n", 0, match.start()) + 1,
                    "rule": label,
                })
        for match in ASSIGNMENT.finditer(content):
            candidate = match.group(1)
            lowered = candidate.lower()
            if any(marker in lowered for marker in SAFE_PLACEHOLDERS):
                continue
            if shannon_entropy(candidate) >= 3.5:
                findings.append({
                    "path": relative.as_posix(),
                    "line": content.count(b"\n", 0, match.start()) + 1,
                    "rule": "high_entropy_assignment",
                })
    return findings


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--all-files",
        action="store_true",
        help="scan the working tree without requiring Git metadata",
    )
    args = parser.parse_args(argv)
    findings = scan_paths(all_files() if args.all_files else repository_files())
    if findings:
        for finding in findings:
            print(f"{finding['path']}:{finding['line']}: possible {finding['rule']}")
        print(f"secret scan failed: {len(findings)} high-confidence finding(s)")
        return 1
    print("secret scan passed: no high-confidence plaintext credentials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
