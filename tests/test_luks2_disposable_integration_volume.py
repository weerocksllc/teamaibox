from __future__ import annotations

import unittest
import json
import re
from pathlib import Path

from tools.luks2_disposable_integration_volume import (
    MAX_INTEGRATION_VOLUME_MIB,
    MIN_INTEGRATION_VOLUME_MIB,
    VOLUME_NAMES,
    paths,
)
from tools.run_luks_unlock_supported_stack_integration import source_files


ROOT = Path(__file__).resolve().parents[1]


class Luks2DisposableIntegrationVolumeTests(unittest.TestCase):
    def test_paths_are_run_scoped_regular_file_boundaries(self):
        value = paths("luks-unlock-integration-20991231-unit-a1")
        self.assertEqual(str(value["root"]), "/tmp/teamaibox-luks-unlock-integration-20991231-unit-a1")
        self.assertEqual(str(value["spareRoot"]), "/tmp/teamaibox-luks-storage-spare-20991231-unit-a1")
        self.assertEqual(value["image"], value["root"] / "volume.img")
        self.assertEqual(value["spareImage"], value["spareRoot"] / "volume.img")
        self.assertTrue(value["mapper"].startswith("teamaibox-luks-unlock-"))
        self.assertTrue(value["spareMapper"].startswith("teamaibox-luks-spare-"))

    def test_supported_stack_data_domains_are_all_mapped(self):
        self.assertEqual(len(VOLUME_NAMES), 23)
        for required in ("postgres_data", "event_bus_data", "object_data", "catalog_secrets",
                         "agent_owner_workspace", "plugin_source_data", "backup_control"):
            self.assertIn(required, VOLUME_NAMES)

    def test_disposable_capacity_bounds_cover_retained_model_artifacts(self):
        self.assertEqual(MIN_INTEGRATION_VOLUME_MIB, 2048)
        self.assertEqual(MAX_INTEGRATION_VOLUME_MIB, 32768)

    def test_disposable_filesystems_are_mounted_noexec(self):
        source = (ROOT / "tools/luks2_disposable_integration_volume.py").read_text()
        self.assertIn('"nodev,nosuid,noexec"', source)
        self.assertNotIn('"nodev,nosuid", f"/dev/mapper/{mapper}"', source)

    def test_data_plane_config_maps_protocol_and_browser_lifecycle_pools(self):
        value = json.loads((ROOT / "deploy/application-catalog-e2e/storage-pools.disposable.v1.json").read_text())
        pools = {item["poolId"]: item for item in value["pools"]}
        self.assertEqual(value["defaultPoolId"], "local.data")
        self.assertEqual(set(pools), {"local.data", "local.spare", "browser.data", "failure.full", "failure.target"})
        self.assertTrue(all(item["luks2Verified"] is True for item in pools.values()))
        self.assertEqual(pools["browser.data"]["root"], "/var/lib/teamaibox/objects/pools/browser.data")

    def test_supported_stack_unlock_runner_binds_all_security_sources(self):
        relative = {item.relative_to(ROOT).as_posix() for item in source_files()}
        for required in (
            "deploy/unlock/compose.yaml",
            "services/unlock-service/server/https-server.mjs",
            "tools/luks2_unlock_helper.py",
            "tools/run_luks_unlock_browser_smoke.mjs",
        ):
            self.assertIn(required, relative)
        runner = (ROOT / "tools/run_luks_unlock_supported_stack_integration.py").read_text()
        self.assertIn('operations["ownedResourcesCleaned"]', runner)
        self.assertIn('(\"docker\", \"image\", \"rm\", image_tag)', runner)
        self.assertIn('(\"test\", \"!\", \"-e\", preboot)', runner)

    def test_storage_fault_injector_preserves_database_boundaries(self):
        source = (ROOT / "deploy/application-catalog-e2e/storage-fault-injector.mjs").read_text()
        self.assertIn("INSERT INTO objects.storage_migrations", source)
        self.assertIn("state='failed',failure_code='injected_corrupt_candidate'", source)
        self.assertLess(source.index("INSERT INTO objects.storage_migrations"),
                        source.index("INSERT INTO objects.storage_allocations"))
        self.assertNotIn("PLATFORM_DATABASE_URL", source)

    def test_a323_fault_injector_uses_platform_parent_and_dedicated_image(self):
        dockerfile = (ROOT / "deploy/application-catalog-e2e/StorageFaultInjectorA323.Dockerfile").read_text()
        overlay = (ROOT / "deploy/application-catalog-e2e/luks-disposable-a323.compose.yaml").read_text()
        creator = (ROOT / "tools/create_storage_a323_plan.py").read_text()
        self.assertRegex(dockerfile, re.compile(r"^ARG PARENT_IMAGE\nFROM \$\{PARENT_IMAGE\}", re.MULTILINE))
        self.assertIn('ENTRYPOINT ["node"]', dockerfile)
        self.assertIn("TEAMAIBOX_STORAGE_FAULT_INJECTOR_IMAGE", overlay)
        self.assertIn('parent_images["catalog-platform-api"]', creator)
        self.assertIn('"storage-fault-injector"', creator)

    def test_a324_protocol_image_has_no_mutable_or_bare_image_id_parent(self):
        dockerfile = (ROOT / "deploy/application-catalog-e2e/ProtocolStorageA324.Dockerfile").read_text()
        creator = (ROOT / "tools/create_storage_a324_plan.py").read_text()
        self.assertIn("node@sha256:", dockerfile)
        self.assertNotIn("PARENT_IMAGE", dockerfile)
        self.assertIn('"teamaibox/platform-api:storage-suite-20260822-a324"', creator)
        self.assertIn('image.pop("buildArgs", None)', creator)

    def test_a325_fault_injector_receives_only_its_database_secret(self):
        overlay = (ROOT / "deploy/application-catalog-e2e/luks-disposable-a325.compose.yaml").read_text()
        creator = (ROOT / "tools/create_storage_a325_plan.py").read_text()
        isolated = overlay.split("storage-fault-injector-a325:", 1)[1]
        self.assertIn("/run/secrets/storage-database-password", isolated)
        self.assertIn("object_data:/var/lib/teamaibox/objects", isolated)
        self.assertNotIn("catalog_secrets:/var/lib/teamaibox-catalog-secrets", isolated)
        self.assertIn('"storage-fault-injector-a325"', creator)


if __name__ == "__main__":
    unittest.main()
