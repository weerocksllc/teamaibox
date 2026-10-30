#!/usr/bin/env python3
"""Capture and evaluate a secrets-free, read-only appliance host fingerprint."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_ALLOWLIST = pathlib.Path('/etc/teamaibox/host-baseline.json')
DEFAULT_EXCEPTIONS = ROOT / "deploy" / "host" / "exceptions"
CONFIG_PATHS = (
    "/etc/crypttab",
    "/etc/docker/daemon.json",
    "/etc/fstab",
    "/etc/nvidia-container-runtime/config.toml",
)
FOUNDATION_PACKAGE = re.compile(
    r"^(?:containerd\.io|cryptsetup(?:-bin|-initramfs)?|docker-(?:buildx-plugin|ce|ce-cli|compose-plugin)|"
    r"libnvidia-container\S*|nvidia-container-toolkit\S*)$"
)
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$")


class HostDriftError(ValueError):
    pass


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


Runner = Callable[[Sequence[str], int], CommandResult]


def _run(command: Sequence[str], timeout: int = 10) -> CommandResult:
    try:
        completed = subprocess.run(
            list(command),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        return CommandResult(127, "", type(error).__name__)
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def _sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _canonical_digest(lines: Sequence[str]) -> dict[str, Any]:
    normalized = sorted({line.strip() for line in lines if line.strip()})
    payload = ("\n".join(normalized) + ("\n" if normalized else "")).encode("utf-8")
    return {"count": len(normalized), "digest": _sha256(payload)}


def _command_value(runner: Runner, command: Sequence[str], pattern: re.Pattern[str] | None = None) -> dict[str, Any]:
    result = runner(command, 10)
    if result.returncode != 0:
        return {"status": "unsupported"}
    value = result.stdout.strip().splitlines()[0].strip() if result.stdout.strip() else ""
    if pattern:
        match = pattern.search(value)
        value = match.group(1) if match else ""
    if not value or not VERSION.fullmatch(value):
        return {"status": "unknown"}
    return {"status": "ok", "value": value}


def _os_release(path: pathlib.Path = pathlib.Path("/etc/os-release")) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {"status": "unsupported"}
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        if "=" not in raw_line or raw_line.lstrip().startswith("#"):
            continue
        key, value = raw_line.split("=", 1)
        if key in {"ID", "VERSION_ID"}:
            values[key] = value.strip().strip('"')
    if not values.get("ID") or not values.get("VERSION_ID"):
        return {"status": "unknown"}
    return {"status": "ok", "id": values["ID"], "versionId": values["VERSION_ID"]}


def _package_state(runner: Runner) -> dict[str, Any]:
    result = runner(("dpkg-query", "-W", "-f=${binary:Package}\t${Version}\\n"), 30)
    if result.returncode != 0:
        return {"status": "unsupported"}
    lines = []
    foundation = []
    for raw_line in result.stdout.splitlines():
        fields = raw_line.split("\t")
        if len(fields) != 2:
            continue
        name, version = fields[0].strip(), fields[1].strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9_-]+)?", name) or not version:
            continue
        line = f"{name}\t{version}"
        lines.append(line)
        base_name = name.split(":", 1)[0]
        if FOUNDATION_PACKAGE.fullmatch(base_name):
            foundation.append({"name": base_name, "version": version})
    state = _canonical_digest(lines)
    return {
        "status": "ok",
        **state,
        "foundationPackages": sorted(foundation, key=lambda item: (item["name"], item["version"])),
    }


def _service_state(runner: Runner) -> dict[str, Any]:
    result = runner(
        ("systemctl", "list-unit-files", "--no-legend", "--no-pager", "--type=service"),
        20,
    )
    if result.returncode != 0:
        return {"status": "unsupported"}
    lines = []
    for raw_line in result.stdout.splitlines():
        fields = raw_line.split()
        if len(fields) < 2 or not fields[0].endswith(".service"):
            continue
        state = fields[1]
        if state in {"enabled", "enabled-runtime", "generated", "indirect", "linked", "linked-runtime", "static"}:
            lines.append(f"{fields[0]}\t{state}")
    docker_active = runner(("systemctl", "is-active", "docker.service"), 5)
    docker_enabled = runner(("systemctl", "is-enabled", "docker.service"), 5)
    return {
        "status": "ok",
        **_canonical_digest(lines),
        "required": {
            "docker.service": {
                "active": docker_active.stdout.strip() if docker_active.returncode == 0 else "unknown",
                "enabled": docker_enabled.stdout.strip() if docker_enabled.returncode == 0 else "unknown",
            }
        },
    }


def _config_fingerprints(paths: Sequence[str] = CONFIG_PATHS) -> dict[str, Any]:
    fingerprints: dict[str, Any] = {}
    for name in paths:
        path = pathlib.Path(name)
        try:
            metadata = path.stat()
            if not path.is_file():
                fingerprints[name] = {"status": "not-file"}
            elif metadata.st_size > 1024 * 1024:
                fingerprints[name] = {"status": "too-large"}
            else:
                fingerprints[name] = {"status": "present", "digest": _sha256(path.read_bytes())}
        except FileNotFoundError:
            fingerprints[name] = {"status": "absent"}
        except PermissionError:
            fingerprints[name] = {"status": "unreadable"}
        except OSError:
            fingerprints[name] = {"status": "unknown"}
    return fingerprints


def capture_snapshot(
    runner: Runner = _run,
    *,
    collected_at: dt.datetime | None = None,
    os_release_path: pathlib.Path = pathlib.Path("/etc/os-release"),
    config_paths: Sequence[str] = CONFIG_PATHS,
) -> dict[str, Any]:
    now = collected_at or dt.datetime.now(dt.timezone.utc)
    architecture = _command_value(runner, ("uname", "-m"))
    kernel = _command_value(runner, ("uname", "-r"))
    docker = _command_value(
        runner,
        ("docker", "version", "--format", "{{.Server.Version}}"),
    )
    toolkit = _command_value(
        runner,
        ("dpkg-query", "-W", "-f=${Version}", "nvidia-container-toolkit"),
    )
    driver = _command_value(
        runner,
        ("nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"),
    )
    return {
        "schemaVersion": 1,
        "collectedAt": now.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "collector": {
            "name": "teamaibox-host-drift",
            "version": "0.1.0",
            "readOnly": True,
            "contentPolicy": "versions-counts-and-sha256-only",
        },
        "architecture": architecture,
        "os": _os_release(os_release_path),
        "kernelRelease": kernel,
        "foundation": {
            "docker": docker,
            "nvidiaContainerToolkit": toolkit,
            "nvidiaDriver": driver,
        },
        "packageState": _package_state(runner),
        "serviceState": _service_state(runner),
        "configurationFingerprints": _config_fingerprints(config_paths),
    }


def _load_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise HostDriftError(f"{path.name} must contain a JSON object")
    return value


def _validate_exception(record: Mapping[str, Any], now: dt.datetime) -> set[str]:
    required_text = (
        "id", "owner", "reason", "exactVersion", "securityAndUpdateImpact",
        "uninstallAndRollback", "validationEvidence", "approvedAt", "expiresAt",
    )
    if record.get("schemaVersion") != 1 or record.get("status") != "active":
        raise HostDriftError("host exception must be an active schemaVersion 1 record")
    for field in required_text:
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise HostDriftError(f"host exception {field} is required")
    drift_keys = record.get("driftKeys")
    if not isinstance(drift_keys, list) or not drift_keys or any(not isinstance(key, str) for key in drift_keys):
        raise HostDriftError("host exception driftKeys must be a non-empty string list")
    try:
        expires = dt.datetime.fromisoformat(record["expiresAt"].replace("Z", "+00:00"))
    except ValueError as error:
        raise HostDriftError("host exception expiresAt is invalid") from error
    if expires <= now:
        raise HostDriftError(f"host exception {record['id']} is expired")
    return set(drift_keys)


def load_exception_keys(directory: pathlib.Path = DEFAULT_EXCEPTIONS, now: dt.datetime | None = None) -> set[str]:
    if not directory.exists():
        return set()
    accepted: set[str] = set()
    current = now or dt.datetime.now(dt.timezone.utc)
    for path in sorted(directory.glob("*.json")):
        accepted.update(_validate_exception(_load_json(path), current))
    return accepted


def _fact(snapshot: Mapping[str, Any], *path: str) -> Any:
    current: Any = snapshot
    for part in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current


def evaluate_snapshot(
    allowlist: Mapping[str, Any],
    snapshot: Mapping[str, Any],
    *,
    accepted_exception_keys: set[str] | None = None,
) -> dict[str, Any]:
    if allowlist.get("schemaVersion") != 1 or allowlist.get("hostInstallPolicy") != "deny-unregistered":
        raise HostDriftError("host allowlist policy is invalid")
    if snapshot.get("schemaVersion") != 1 or _fact(snapshot, "collector", "readOnly") is not True:
        raise HostDriftError("host snapshot is invalid or not read-only")
    baseline = allowlist.get("baseline")
    if not isinstance(baseline, Mapping):
        raise HostDriftError("host allowlist baseline is required")
    accepted = accepted_exception_keys or set()
    drifts: list[dict[str, Any]] = []

    comparisons = {
        "architecture": (_fact(snapshot, "architecture", "value"), baseline.get("architecture")),
        "os.id": (_fact(snapshot, "os", "id"), _fact(baseline, "os", "id")),
        "os.versionId": (_fact(snapshot, "os", "versionId"), _fact(baseline, "os", "versionId")),
        "kernelRelease": (_fact(snapshot, "kernelRelease", "value"), baseline.get("kernelRelease")),
        "foundation.docker": (_fact(snapshot, "foundation", "docker", "value"), _fact(baseline, "foundation", "docker")),
        "foundation.nvidiaContainerToolkit": (
            _fact(snapshot, "foundation", "nvidiaContainerToolkit", "value"),
            _fact(baseline, "foundation", "nvidiaContainerToolkit"),
        ),
        "foundation.nvidiaDriver": (
            _fact(snapshot, "foundation", "nvidiaDriver", "value"),
            _fact(baseline, "foundation", "nvidiaDriver"),
        ),
        "packageState.digest": (_fact(snapshot, "packageState", "digest"), _fact(baseline, "packageState", "digest")),
        "packageState.count": (_fact(snapshot, "packageState", "count"), _fact(baseline, "packageState", "count")),
        "serviceState.digest": (_fact(snapshot, "serviceState", "digest"), _fact(baseline, "serviceState", "digest")),
        "serviceState.count": (_fact(snapshot, "serviceState", "count"), _fact(baseline, "serviceState", "count")),
        "serviceState.docker.active": (
            _fact(snapshot, "serviceState", "required", "docker.service", "active"), "active",
        ),
        "serviceState.docker.enabled": (
            _fact(snapshot, "serviceState", "required", "docker.service", "enabled"), "enabled",
        ),
    }
    for key, (actual, expected) in comparisons.items():
        if expected is None or actual != expected:
            drifts.append({
                "key": key,
                "classification": "registered-exception" if key in accepted else "unapproved-drift",
                "expected": expected,
                "actual": actual,
            })

    expected_configs = baseline.get("configurationFingerprints")
    actual_configs = snapshot.get("configurationFingerprints")
    if not isinstance(expected_configs, Mapping) or not isinstance(actual_configs, Mapping):
        raise HostDriftError("configuration fingerprints are required")
    for path in sorted(set(expected_configs) | set(actual_configs)):
        key = "configurationFingerprint:" + path
        expected = expected_configs.get(path)
        actual = actual_configs.get(path)
        if actual != expected:
            drifts.append({
                "key": key,
                "classification": "registered-exception" if key in accepted else "unapproved-drift",
                "expected": expected,
                "actual": actual,
            })

    unapproved = [drift for drift in drifts if drift["classification"] == "unapproved-drift"]
    return {
        "schemaVersion": 1,
        "target": allowlist.get("target"),
        "snapshotCollectedAt": snapshot.get("collectedAt"),
        "conforming": not unapproved,
        "releaseEvidenceEligible": not unapproved,
        "mutationPerformed": False,
        "drifts": drifts,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    capture = subparsers.add_parser("capture", help="capture a read-only sanitized snapshot")
    capture.add_argument("--pretty", action="store_true")
    capture.add_argument("--output", type=pathlib.Path)
    check = subparsers.add_parser("check", help="compare against this installation's recorded host baseline")
    check.add_argument("--allowlist", type=pathlib.Path, default=DEFAULT_ALLOWLIST)
    check.add_argument("--exceptions", type=pathlib.Path, default=DEFAULT_EXCEPTIONS)
    check.add_argument("--snapshot", type=pathlib.Path)
    check.add_argument("--pretty", action="store_true")
    check.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args(argv)

    if args.command == "capture":
        result = capture_snapshot()
    else:
        snapshot = _load_json(args.snapshot) if args.snapshot else capture_snapshot()
        result = evaluate_snapshot(
            _load_json(args.allowlist),
            snapshot,
            accepted_exception_keys=load_exception_keys(args.exceptions),
        )
    serialized = json.dumps(result, indent=2 if args.pretty else None, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(serialized, encoding="utf-8")
        temporary.replace(args.output)
    else:
        print(serialized, end="")
    if args.command == "check" and not result["releaseEvidenceEligible"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
