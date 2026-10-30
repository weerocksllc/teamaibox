#!/usr/bin/env python3
"""Apply verified Team AI Box migrations using psql connection environment."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
from typing import Sequence

try:
    from .validate_migrations import MANIFEST, MIGRATION_ROOT, MigrationError, validate_manifest
except ImportError:  # direct script execution
    from validate_migrations import MANIFEST, MIGRATION_ROOT, MigrationError, validate_manifest


PSQL_BASE = (
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--no-align",
    "--tuples-only",
    "--quiet",
)
ADVISORY_LOCK_KEY = 8244704666841902962


def _psql(psql: str | Sequence[str], sql: str) -> str:
    environment = dict(os.environ)
    command = [psql] if isinstance(psql, str) else list(psql)
    if not command or any(not isinstance(item, str) or not item for item in command):
        raise MigrationError("psql command is invalid")
    completed = subprocess.run(
        [*command, *PSQL_BASE],
        input=sql,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=120,
        env=environment,
    )
    if completed.returncode != 0:
        raise MigrationError("psql migration command failed: " + completed.stderr.strip())
    return completed.stdout.strip()


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def applied_migrations(psql: str | Sequence[str]) -> dict[int, str]:
    exists = _psql(psql, "SELECT to_regclass('public.teamaibox_schema_migrations') IS NOT NULL;")
    if exists != "t":
        return {}
    rows = _psql(
        psql,
        "SELECT version::text || '|' || sha256 FROM public.teamaibox_schema_migrations ORDER BY version;",
    )
    result: dict[int, str] = {}
    for line in rows.splitlines():
        if not line:
            continue
        version, checksum = line.split("|", 1)
        result[int(version)] = checksum
    return result


def apply_all(psql: str | Sequence[str], dry_run: bool = False) -> list[int]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    applied = applied_migrations(psql)
    executed: list[int] = []
    for migration in manifest["migrations"]:
        version = migration["version"]
        checksum = migration["upSha256"]
        if version in applied:
            if applied[version] != checksum:
                raise MigrationError(f"applied migration {version} checksum differs from source")
            continue
        if dry_run:
            executed.append(version)
            continue
        source = (MIGRATION_ROOT / migration["up"]).read_text(encoding="utf-8")
        record = (
            "INSERT INTO public.teamaibox_schema_migrations "
            "(version, name, sha256, execution_milliseconds) VALUES ("
            f"{version}, {_quote_literal(migration['name'])}, {_quote_literal(checksum)}, "
            "floor(extract(epoch FROM (clock_timestamp() - transaction_timestamp())) * 1000)::bigint"
            ");"
        )
        wrapped = (
            "BEGIN;\n"
            f"SELECT pg_advisory_xact_lock({ADVISORY_LOCK_KEY});\n"
            "SET LOCAL lock_timeout = '10s';\n"
            "SET LOCAL statement_timeout = '120s';\n"
            + source
            + "\n"
            + record
            + "\nCOMMIT;\n"
        )
        _psql(psql, wrapped)
        executed.append(version)
    return executed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psql", default="psql", help="psql executable path")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        versions = apply_all(args.psql, dry_run=args.dry_run)
    except MigrationError as error:
        parser.error(str(error))
    print(json.dumps({"applied" if not args.dry_run else "pending": versions}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
