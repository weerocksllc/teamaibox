from __future__ import annotations

import copy
import hashlib
import json
import pathlib
import re
import tempfile
import unittest
from unittest import mock

from tools import apply_migrations
from tools.validate_migrations import MANIFEST, MIGRATION_ROOT, MigrationError, validate_manifest


class MigrationCatalogTests(unittest.TestCase):
    def test_smoke_queries_do_not_compare_an_unqualified_column_to_itself(self):
        smoke_root = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "persistence" / "tests"
        )
        offenders = []
        self_comparison = re.compile(
            r"\b(?:WHERE|AND|OR)\s+([a-z_][a-z0-9_]*)\s*=\s*\1\b",
            re.IGNORECASE,
        )
        for path in smoke_root.glob("*_smoke.sql"):
            if self_comparison.search(path.read_text(encoding="utf-8")):
                offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_completed_assistant_message_smoke_inserts_pin_created_at(self):
        smoke_root = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "persistence" / "tests"
        )
        offenders = []
        for path in smoke_root.glob("*_smoke.sql"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(
                r"INSERT INTO platform\.assistant_messages\s*\((.*?)\)",
                source,
                re.DOTALL,
            ):
                columns = match.group(1)
                if "completed_at" in columns and "created_at" not in columns:
                    offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_worker_instance_smoke_inserts_pin_the_node_generation(self):
        smoke_root = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "persistence" / "tests"
        )
        inserts = []
        for path in smoke_root.glob("*_smoke.sql"):
            source = path.read_text(encoding="utf-8")
            inserts.extend(
                (path.name, match.group(1))
                for match in re.finditer(
                    r"INSERT INTO compute\.worker_instances\s*\((.*?)\)",
                    source,
                    re.DOTALL,
                )
            )
        self.assertGreater(len(inserts), 0)
        self.assertEqual(
            [name for name, columns in inserts if "node_generation" not in columns],
            [],
        )

    def test_authorization_smoke_uses_the_runtime_permission_catalog(self):
        runtime_source = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "authorization" / "src" / "index.mjs"
        ).read_text(encoding="utf-8")
        smoke_source = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "persistence" / "tests" / "authorization_smoke.sql"
        ).read_text(encoding="utf-8")
        runtime_block = re.search(r"const permissionList = \[(.*?)\];", runtime_source, re.DOTALL)
        smoke_block = re.search(
            r"expected_permissions constant text\[\] := ARRAY\[(.*?)\n\s*\];",
            smoke_source,
            re.DOTALL,
        )
        self.assertIsNotNone(runtime_block)
        self.assertIsNotNone(smoke_block)
        runtime_permissions = re.findall(r'"([a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)+)"', runtime_block.group(1))
        smoke_permissions = re.findall(r"'([a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)+)'", smoke_block.group(1))
        self.assertEqual(len(runtime_permissions), len(set(runtime_permissions)))
        self.assertEqual(len(smoke_permissions), len(set(smoke_permissions)))
        self.assertEqual(set(smoke_permissions), set(runtime_permissions))

    def test_identity_foreign_keys_use_the_foundation_iam_schema(self):
        offenders = [
            path.name for path in MIGRATION_ROOT.glob("*.up.sql")
            if "REFERENCES identity.identities" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual(offenders, [])

    def test_every_schema_qualified_foreign_key_targets_a_declared_table(self):
        sources = "\n".join(
            path.read_text(encoding="utf-8") for path in MIGRATION_ROOT.glob("*.up.sql")
        )
        declared = set(re.findall(r"CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+\.[a-z_]+)", sources))
        referenced = set(re.findall(r"REFERENCES ([a-z_]+\.[a-z_]+)", sources))
        self.assertEqual(sorted(referenced - declared), [])

    def test_every_single_column_foreign_key_targets_a_declared_column(self):
        sources = "\n".join(
            path.read_text(encoding="utf-8") for path in MIGRATION_ROOT.glob("*.up.sql")
        )
        tables: dict[str, set[str]] = {}
        for match in re.finditer(
            r"CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+\.[a-z_]+)\s*\((.*?)\);",
            sources,
            re.DOTALL,
        ):
            columns = set()
            for line in match.group(2).splitlines():
                column = re.match(r"\s*([a-z_][a-z0-9_]*)\s+", line)
                if column and column.group(1).upper() not in {"PRIMARY", "UNIQUE", "CHECK", "CONSTRAINT", "FOREIGN"}:
                    columns.add(column.group(1))
            tables[match.group(1)] = columns
        missing = sorted({
            f"{table}({column})"
            for table, column in re.findall(
                r"REFERENCES\s+([a-z_]+\.[a-z_]+)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)",
                sources,
            )
            if table in tables and column not in tables[table]
        })
        self.assertEqual(missing, [])

    def test_wireless_casting_schema_is_secret_free_and_bounded(self):
        source = (
            MIGRATION_ROOT / "000069_wireless_casting_control_plane.up.sql"
        ).read_text(encoding="utf-8")
        table_blocks = "\n".join(re.findall(
            r"CREATE TABLE platform\.cast_[a-z_]+\s*\((.*?)\n\);",
            source,
            re.DOTALL,
        ))
        self.assertNotRegex(
            table_blocks,
            r"(?i)\b(pin|secret|token|credential|pairing_key|media_key|source_device|frame|audio|payload)\b",
        )
        self.assertIn("cast_sessions_one_non_terminal_per_appliance_idx", source)
        self.assertIn("live_viewers >= 8", source)
        self.assertIn("downgrade_cast_audience_to_owner", source)
        self.assertIn("cast_session_events_append_only", source)

    def test_committed_catalog_is_valid(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        summary = validate_manifest(manifest)
        self.assertEqual(summary["migrations"], len(manifest["migrations"]))
        self.assertGreaterEqual(summary["requiredTables"], 15)

    def test_fleet_orphan_reconciliation_identity_is_database_guarded(self) -> None:
        source = (
            MIGRATION_ROOT / "000074_fleet_orphan_reconciliation_identity.up.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("fleet_operation_orphans_reconciliation_id_format", source)
        self.assertIn("BEFORE INSERT OR UPDATE OR DELETE", source)
        self.assertIn("fleet orphan reconciliation identity must be persisted before cleanup", source)
        self.assertIn("fleet orphan reconciliation identity cannot change", source)
        self.assertIn("resolved fleet orphan journal rows cannot change", source)
        self.assertIn("frozen fleet orphan identity cannot change", source)

    def test_protected_office_deployment_actions_are_idempotent_and_recoverable(self) -> None:
        source = (
            MIGRATION_ROOT / "000075_protected_office_deployment_action_journal.up.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("UNIQUE", source)
        self.assertIn("BEFORE INSERT OR UPDATE OR DELETE", source)
        self.assertIn("recovery must be journaled before replay", source)
        self.assertIn("terminal protected deployment action cannot change", source)
        self.assertIn("immutable identity changed", source)

    def test_single_appliance_casting_is_browser_only_and_preserves_history(self) -> None:
        up = (
            MIGRATION_ROOT / "000105_single_appliance_casting.up.sql"
        ).read_text(encoding="utf-8")
        smoke = (
            pathlib.Path(__file__).resolve().parents[1]
            / "packages" / "persistence" / "tests"
            / "wireless_casting_control_plane_smoke.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("NEW.initiator_identity_id, 'cast:view', NEW.created_at", up)
        self.assertIn("NEW.output_sinks IS DISTINCT FROM ARRAY['browser']::text[]", up)
        self.assertIn("casting output changes require browser-only delivery", up)
        self.assertIn("non-browser casting output was accepted", smoke)
        self.assertIn("casting creation without cast:view was accepted", smoke)
        self.assertIn("casting output update enabled physical delivery", smoke)
        self.assertIn("legacy casting lifecycle or output history was changed", smoke)

    def test_protected_office_deployment_v5_identity_is_fail_closed_and_roundtrip_safe(self) -> None:
        up = (
            MIGRATION_ROOT / "000077_protected_office_deployment_v5_identity.up.sql"
        ).read_text(encoding="utf-8")
        down = (
            MIGRATION_ROOT / "000077_protected_office_deployment_v5_identity.down.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("protected_office_deployment_actions_run_id_check", up)
        self.assertIn("protected-office-set-deployment(-v5)?", up)
        self.assertIn("protected-office-set-deployment-v5-", down)
        self.assertIn("cannot remove protected-office v5 identity", down)

    def test_appliance_postgres_image_binds_the_exact_manifest(self) -> None:
        dockerfile = (
            pathlib.Path(__file__).resolve().parents[1]
            / "deploy" / "images" / "postgres.Dockerfile"
        ).read_text(encoding="utf-8")
        checksum = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
        self.assertIn(f"ARG MIGRATION_MANIFEST_SHA256={checksum}", dockerfile)
        self.assertIn("ENV TEAMAIBOX_MIGRATION_MANIFEST_SHA256=${MIGRATION_MANIFEST_SHA256}", dockerfile)

    def test_application_fixture_state_check_tracks_the_current_schema(self) -> None:
        state_check = (
            pathlib.Path(__file__).resolve().parents[1]
            / "deploy" / "application-catalog-e2e" / "state-check.sh"
        ).read_text(encoding="utf-8")
        self.assertIn('/opt/teamaibox/migrations/manifest.json', state_check)
        self.assertIn('"$migrations" == "$expected_migrations"', state_check)
        self.assertIn('"schemaVersion":%d', state_check)
        self.assertIn("team_memberships", state_check)

    def test_rejects_checksum_drift(self) -> None:
        manifest = copy.deepcopy(json.loads(MANIFEST.read_text(encoding="utf-8")))
        manifest["migrations"][0]["upSha256"] = "0" * 64
        with self.assertRaisesRegex(MigrationError, "checksum mismatch"):
            validate_manifest(manifest)

    def test_rejects_destructive_up_migration(self) -> None:
        original = json.loads(MANIFEST.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            up = root / "000001_foundation.up.sql"
            down = root / "000001_foundation.down.sql"
            up.write_text("DROP TABLE public.example;\n", encoding="utf-8")
            down.write_text("SELECT 1;\n", encoding="utf-8")
            manifest = {
                **original,
                "migrations": [
                    {
                        "version": 1,
                        "name": "foundation",
                        "up": up.name,
                        "upSha256": hashlib.sha256(up.read_bytes()).hexdigest(),
                        "down": down.name,
                        "downSha256": hashlib.sha256(down.read_bytes()).hexdigest(),
                    }
                ],
            }
            with self.assertRaisesRegex(MigrationError, "destructive"):
                validate_manifest(manifest, root)

    def test_runner_wraps_migration_and_records_checksum_atomically(self) -> None:
        commands: list[str] = []

        def capture(_psql: str, sql: str) -> str:
            commands.append(sql)
            return ""

        with (
            mock.patch.object(apply_migrations, "applied_migrations", return_value={}),
            mock.patch.object(apply_migrations, "_psql", side_effect=capture),
        ):
            versions = [row["version"] for row in json.loads(MANIFEST.read_text())["migrations"]]
            self.assertEqual(apply_migrations.apply_all("psql"), versions)
            self.assertEqual(len(commands), len(versions))
        self.assertTrue(commands[0].startswith("BEGIN;"))
        self.assertIn("pg_advisory_xact_lock", commands[0])
        self.assertIn("CREATE SCHEMA iam", commands[0])
        self.assertIn("teamaibox_schema_migrations", commands[0])
        self.assertTrue(commands[0].rstrip().endswith("COMMIT;"))

    def test_runner_is_idempotent_for_matching_applied_checksum(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        applied = {
            migration["version"]: migration["upSha256"]
            for migration in manifest["migrations"]
        }
        with (
            mock.patch.object(apply_migrations, "applied_migrations", return_value=applied),
            mock.patch.object(apply_migrations, "_psql") as execute,
        ):
            self.assertEqual(apply_migrations.apply_all("psql"), [])
        execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
