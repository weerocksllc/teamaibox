#!/usr/bin/env python3
"""Run migrations and SQL smoke tests in a disposable locked PostgreSQL image."""

from __future__ import annotations

import argparse
import json
import pathlib
import secrets
import subprocess
import time
from typing import Sequence

try:
    from .apply_migrations import _psql, apply_all
    from .validate_migrations import MANIFEST, MIGRATION_ROOT, validate_manifest
except ImportError:  # direct script execution
    from apply_migrations import _psql, apply_all
    from validate_migrations import MANIFEST, MIGRATION_ROOT, validate_manifest


ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGE_LOCK = ROOT / "deploy" / "compose" / "images.arm64.json"
SMOKE_FILES = (
    ROOT / "packages" / "persistence" / "tests" / "foundation_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "outbox_inbox_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "local_identity_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "authorization_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "task_center_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "api_credentials_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "object_envelope_encryption_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "object_metadata_transactions_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "object_access_grants_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "storage_pools_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "durable_compute_queue_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "scheduler_leases_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "compute_worker_lifecycle_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "node_exclusive_leases_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "realtime_capacity_reservations_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "plugin_verified_imports_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "plugin_lifecycle_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "plugin_access_channels_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_profile_registrations_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_artifact_cache_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_engine_jobs_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_validation_evidence_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "assistant_conversations_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "agent_operation_confirmations_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "messaging_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "team_drive_metadata_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_profile_lifecycle_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "model_revalidation_triggers_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "wireless_casting_control_plane_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "casting_viewer_lifetime_smoke.sql",
    ROOT / "packages" / "persistence" / "tests" / "protected_office_set_transactions_smoke.sql",
)


class DatabaseSmokeError(RuntimeError):
    pass


def down_transaction(source: str) -> str:
    """Keep locks and rollback guards in one bounded transaction."""
    return ("BEGIN;\nSET LOCAL lock_timeout = '10s';\n"
            "SET LOCAL statement_timeout = '120s';\n" + source + "\nCOMMIT;\n")


def _run(command: Sequence[str], *, timeout: int = 120) -> str:
    completed = subprocess.run(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=timeout,
    )
    if completed.returncode != 0:
        raise DatabaseSmokeError("database smoke command failed: " + " ".join(command[:3]))
    return completed.stdout.strip()


def locked_postgres_reference() -> str:
    lock = json.loads(IMAGE_LOCK.read_text(encoding="utf-8"))
    validate_manifest(json.loads(MANIFEST.read_text(encoding="utf-8")))
    reference = lock.get("images", {}).get("postgres", {}).get("reference")
    if not isinstance(reference, str) or "@sha256:" not in reference:
        raise DatabaseSmokeError("PostgreSQL ARM64 image is not digest locked")
    return reference


def run_smoke(image: str, platform: str = "linux/arm64/v8") -> dict[str, object]:
    if not image.startswith("docker.io/library/postgres@sha256:") or len(image.rsplit(":", 1)[-1]) != 64:
        raise DatabaseSmokeError("only the locked PostgreSQL digest reference is accepted")
    if platform != "linux/arm64/v8":
        raise DatabaseSmokeError("database smoke platform must be Linux ARM64/v8")
    container = "teamaibox-ci-postgres-" + secrets.token_hex(6)
    command = [
        "docker", "exec", "-i", container,
        "psql", "-U", "teamaibox", "-d", "teamaibox",
    ]
    started = False
    try:
        _run([
            "docker", "run", "--detach", "--name", container,
            "--pull", "never",
            "--platform", platform,
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,size=16m",
            "--tmpfs", "/var/lib/postgresql:rw,nosuid,nodev,size=1g",
            "--pids-limit", "256",
            "--memory", "2g",
            "--cpus", "2",
            "--security-opt", "no-new-privileges",
            "--env", "POSTGRES_DB=teamaibox",
            "--env", "POSTGRES_USER=teamaibox",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
            image,
        ])
        started = True
        for _ in range(120):
            ready = subprocess.run(
                ["docker", "exec", container, "pg_isready", "-U", "teamaibox", "-d", "teamaibox"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise DatabaseSmokeError("PostgreSQL did not become ready within 60 seconds")

        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        expected_versions = list(range(1, len(manifest["migrations"]) + 1))
        first = apply_all(command)
        second = apply_all(command)
        if first != expected_versions or second != []:
            raise DatabaseSmokeError("migration application was not complete and idempotent")
        for filename in SMOKE_FILES:
            _psql(command, filename.read_text(encoding="utf-8"))
        applied = _psql(command, "SELECT count(*) FROM public.teamaibox_schema_migrations;")
        if applied != str(len(expected_versions)):
            raise DatabaseSmokeError("migration ledger does not contain every manifest entry")

        for migration in reversed(manifest["migrations"]):
            source = (MIGRATION_ROOT / migration["down"]).read_text(encoding="utf-8")
            _psql(command, down_transaction(source))
        remaining = _psql(
            command,
            "SELECT count(*) FROM pg_namespace WHERE nspname IN ('iam','platform','plugins','compute','audit','objects','files');",
        )
        if remaining != "0":
            raise DatabaseSmokeError("down migrations left foundation schemas behind")
        return {"applied": first, "idempotent": True, "downClean": True}
    finally:
        if started:
            subprocess.run(
                ["docker", "rm", "--force", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
            )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=None)
    args = parser.parse_args(argv)
    reference = locked_postgres_reference()
    if args.image is not None and args.image != reference:
        parser.error("--image must equal the committed PostgreSQL ARM64 lock")
    try:
        result = run_smoke(reference)
    except DatabaseSmokeError as error:
        parser.error(str(error))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
