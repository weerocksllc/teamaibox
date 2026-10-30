#!/usr/bin/env python3
"""Validate ordered, checksummed PostgreSQL migration sources."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION_ROOT = ROOT / "packages" / "persistence" / "migrations"
MANIFEST = MIGRATION_ROOT / "manifest.json"
PINNED_MANIFEST_DOCKERFILES = (
    ROOT / "deploy" / "appliance" / "Migration.Dockerfile",
    ROOT / "deploy" / "images" / "postgres.Dockerfile",
)
DIGEST = re.compile(r"^[0-9a-f]{64}$")
SAFE_FILE = re.compile(r"^[0-9]{6}_[a-z][a-z0-9_]*\.(up|down)\.sql$")
REQUIRED_TABLES = {
    "iam.identities",
    "iam.appliance_bootstrap",
    "iam.authentication_states",
    "iam.login_rate_limits",
    "iam.sessions",
    "iam.owner_recovery_codes",
    "iam.permissions",
    "iam.role_scopes",
    "iam.role_permissions",
    "iam.role_bindings",
    "iam.service_account_grants",
    "iam.api_credentials",
    "iam.roles",
    "plugins.plugins",
    "plugins.verified_imports",
    "plugins.lifecycle_operations",
    "plugins.runtime_slots",
    "plugins.migration_runs",
    "plugins.delegated_user_tokens",
    "plugins.compute_capability_registrations",
    "compute.nodes",
    "compute.node_groups",
    "compute.node_group_memberships",
    "compute.capabilities",
    "compute.model_profiles",
    "compute.model_profile_placement_revisions",
    "compute.model_profile_registrations",
    "compute.model_cache_accounts",
    "compute.model_artifact_imports",
    "compute.model_cache_chunks",
    "compute.model_artifacts",
    "compute.model_artifact_import_chunks",
    "compute.model_artifact_chunk_map",
    "compute.model_engine_build_jobs",
    "compute.model_engine_build_operations",
    "compute.model_engine_deployment_jobs",
    "compute.model_engine_deployment_operations",
    "compute.model_validation_runs",
    "compute.model_validation_operations",
    "compute.model_validation_stages",
    "compute.model_profile_lifecycle_events",
    "compute.model_experimental_routing_opt_ins",
    "compute.model_profile_certification_baselines",
    "compute.model_profile_revalidation_checks",
    "compute.jobs",
    "compute.attempts",
    "compute.leases",
    "compute.worker_instances",
    "compute.node_exclusive_intents",
    "compute.realtime_sessions",
    "compute.artifacts",
    "compute.job_events",
    "compute.job_quota_policies",
    "compute.providers",
    "compute.protected_office_sets",
    "compute.protected_office_set_transactions",
    "compute.node_onboarding_transactions",
    "compute.node_onboarding_events",
    "compute.node_bootstrap_coordinations",
    "compute.node_bootstrap_orphans",
    "compute.node_bootstrap_orphan_actions",
    "audit.audit_references",
    "platform.configuration_versions",
    "platform.agent_operation_confirmations",
    "platform.assistant_conversations",
    "platform.assistant_messages",
    "platform.assistant_runs",
    "platform.assistant_events",
    "platform.agent_session_bindings",
    "platform.agent_prompts",
    "platform.agent_events",
    "platform.agent_crash_reconciliations",
    "platform.cast_sessions",
    "platform.cast_audience_targets",
    "platform.cast_viewer_invitations",
    "platform.cast_viewer_grants",
    "platform.cast_session_events",
    "platform.agent_sandboxes",
    "platform.agent_sandbox_operations",
    "platform.messaging_conversations",
    "platform.messaging_participants",
    "platform.messaging_messages",
    "platform.messaging_attachments",
    "platform.messaging_delivery_receipts",
    "platform.messaging_notifications",
    "platform.messaging_events",
    "platform.messaging_presence",
    "platform.messaging_presence_connections",
    "platform.inbox_receipts",
    "platform.outbox_events",
    "objects.encrypted_blobs",
    "objects.namespaces",
    "objects.multipart_uploads",
    "objects.blob_claims",
    "objects.object_entries",
    "objects.object_versions",
    "objects.multipart_parts",
    "objects.file_entries",
    "objects.file_versions",
    "objects.namespace_bindings",
    "objects.access_grants",
    "objects.access_events",
    "objects.storage_pools",
    "objects.storage_pool_data_classes",
    "objects.storage_placement_reservations",
    "objects.storage_placement_targets",
    "objects.storage_allocations",
    "objects.storage_migrations",
    "files.roots",
    "files.entries",
    "files.versions",
    "files.acl",
    "files.shares",
    "source_center.offline_media",
    "source_center.offline_media_artifacts",
    "source_center.offline_media_approvals",
    "compute.node_enrollments",
    "compute.node_heartbeat_events",
    "compute.node_metric_snapshots",
    "platform.diagnostic_signals",
    "platform.health_signals",
    "platform.operational_alerts",
    "platform.diagnostic_exports",
    "platform.backup_sets",
    "platform.backup_set_components",
    "platform.backup_rehearsal_policies",
    "platform.backup_recovery_runs",
    "platform.maintenance_plans",
    "platform.maintenance_node_evidence",
}


class MigrationError(ValueError):
    pass


def _sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_manifest(manifest: Mapping[str, Any], root: pathlib.Path = MIGRATION_ROOT) -> dict[str, int]:
    if manifest.get("schemaVersion") != 1 or manifest.get("database") != "postgresql":
        raise MigrationError("migration manifest must be schema 1 for PostgreSQL")
    minimum = manifest.get("minimumMajorVersion")
    if not isinstance(minimum, int) or minimum < 18:
        raise MigrationError("PostgreSQL 18 or newer must be declared")
    migrations = manifest.get("migrations")
    if not isinstance(migrations, list) or not migrations:
        raise MigrationError("at least one migration is required")

    versions: list[int] = []
    up_sources: list[str] = []
    for migration in migrations:
        if not isinstance(migration, Mapping):
            raise MigrationError("each migration must be an object")
        version = migration.get("version")
        name = migration.get("name")
        if not isinstance(version, int) or version <= 0:
            raise MigrationError("migration versions must be positive integers")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{2,63}", name):
            raise MigrationError(f"invalid migration name at version {version}")
        versions.append(version)
        for direction in ("up", "down"):
            filename = migration.get(direction)
            checksum = migration.get(direction + "Sha256")
            if not isinstance(filename, str) or not SAFE_FILE.fullmatch(filename):
                raise MigrationError(f"invalid {direction} filename at version {version}")
            if not isinstance(checksum, str) or not DIGEST.fullmatch(checksum):
                raise MigrationError(f"invalid {direction} checksum at version {version}")
            path = root / filename
            if not path.is_file():
                raise MigrationError(f"missing migration source: {filename}")
            if _sha256(path) != checksum:
                raise MigrationError(f"checksum mismatch: {filename}")
            source = path.read_text(encoding="utf-8")
            if re.search(r"(?im)^\s*(BEGIN|COMMIT|ROLLBACK)\s*;", source):
                raise MigrationError(f"{filename} must let the runner own its transaction")
            if re.search(r"(?m)^\s*\\", source):
                raise MigrationError(f"{filename} must not contain psql meta-commands")
            if direction == "up":
                inspected = source
                if version == 117 and migration.get("name") == "retire_resource_bookings":
                    # User-authorized retirement of bookkeeping only. No CASCADE,
                    # guest/session rows, business tables or disks are permitted.
                    for table in ("compute.cast_resource_reservations", "compute.computer_storage_reservations"):
                        inspected = inspected.replace("DROP TABLE " + table + ";", "")
                if version == 118 and migration.get("name") == "retire_model_import_bookings":
                    # Only the two retired counters; no bytes, imports, offsets,
                    # identities or CASCADE may be removed.
                    for statement in (
                        "ALTER TABLE compute.model_cache_accounts DROP COLUMN reserved_bytes;",
                        "ALTER TABLE compute.model_artifact_imports DROP COLUMN reservation_bytes;",
                    ):
                        inspected = inspected.replace(statement, "")
                if re.search(r"(?i)\bTRUNCATE\b|\bDROP\s+(?:TABLE|SCHEMA|COLUMN|TYPE|DATABASE)\b", inspected):
                    raise MigrationError(f"up migration contains a destructive statement: {filename}")
                if re.search(r"(?i)\bCREATE\s+EXTENSION\b", source):
                    raise MigrationError(f"up migration must not install host/database extensions: {filename}")
                up_sources.append(source)

    if versions != list(range(1, len(versions) + 1)):
        raise MigrationError("migration versions must be ordered and contiguous from 1")
    combined = "\n".join(up_sources)
    created = set(
        re.findall(
            r"(?im)^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)",
            combined,
        )
    )
    missing = REQUIRED_TABLES - created
    if missing:
        raise MigrationError("required foundation tables missing: " + ", ".join(sorted(missing)))
    return {"migrations": len(versions), "requiredTables": len(REQUIRED_TABLES)}


def validate_pinned_manifest_digests(manifest_path: pathlib.Path = MANIFEST) -> int:
    expected = _sha256(manifest_path)
    checked = 0
    for dockerfile in PINNED_MANIFEST_DOCKERFILES:
        source = dockerfile.read_text(encoding="utf-8")
        direct = re.search(r"^ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=([0-9a-f]{64})$", source, re.MULTILINE)
        argument = re.search(r"^ARG MIGRATION_MANIFEST_SHA256=([0-9a-f]{64})$", source, re.MULTILINE)
        argument_bound = "ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_MANIFEST_SHA256}" in source
        pinned = direct.group(1) if direct is not None else argument.group(1) if argument is not None and argument_bound else None
        if pinned != expected:
            raise MigrationError(f"migration manifest pin is stale: {dockerfile.relative_to(ROOT)}")
        checked += 1
    return checked


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    summary = validate_manifest(manifest)
    pinned = validate_pinned_manifest_digests()
    print(
        f"migration catalog valid: {summary['migrations']} migration, "
        f"{summary['requiredTables']} required tables, {pinned} pinned manifest"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
