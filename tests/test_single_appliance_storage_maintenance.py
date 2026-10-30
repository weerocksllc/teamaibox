"""Local-only maintenance boundaries; never mounts, formats, or contacts a host."""
import ast
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pool = load("local_phone_pool_test", "deploy/android/cuttlefish/phone_file_pool.py")
boot = load("local_phone_boot_test", "deploy/android/cuttlefish/phone_boot_resume.py")
windows = load("local_windows_storage_test", "deploy/windows-arm64/lab_storage.py")
growth = load("local_phone_growth_test", "deploy/android/cuttlefish/phone_pool_growth.py")


def plan():
    return {
        "schemaVersion": 2, "poolId": "11111111-1111-4111-8111-111111111111",
        "capacityBytes": 96 * 1024**3, "phoneQuotaBytes": 24 * 1024**3,
        "authorization": {"filePoolCreationApproved": True, "physicalDiskEraseApproved": False,
                          "repartitionApproved": False, "nodeRebootApproved": False},
        "appliance": {"hostname": "local-appliance", "rootFilesystemUUID": "22222222-2222-4222-8222-222222222222"},
        "keyStore": {"encryptedRoot": "/srv/appliance-data", "mapper": "appliance-data",
                     "filesystemUUID": "33333333-3333-4333-8333-333333333333"},
    }


def boot_plan():
    value = plan()
    return {"version": 2, "runId": "phone-boot-services-20261016-a1", "poolId": value["poolId"],
            "applianceHostname": value["appliance"]["hostname"],
            "stage": "/var/lib/teamaibox-phone-boot-services-20261016-a1",
            "root": "/srv/teamaibox/phone-pools/" + value["poolId"],
            "agent": {"id": "a" * 64, "image": "sha256:" + "b" * 64},
            "socketDirectory": "/run/teamaibox-phone-local", "storageUnit": "teamaibox-phone-local-storage.service"}


class LocalStorageMaintenanceTest(unittest.TestCase):
    def test_plan_accepts_local_capacity_not_the_old_fixed_pool(self):
        self.assertEqual(pool.validate_plan(plan())["capacityBytes"], 96 * 1024**3)

    def test_rejects_old_remote_plan_and_roles(self):
        for extra in ({"schemaVersion": 1}, {"node": {}}, {"custody": {}},
                      {"sshTarget": "other"}, {"primaryHost": "other"}):
            with self.subTest(extra=extra), self.assertRaises(pool.PoolError):
                pool.validate_plan({**plan(), **extra})

    def test_key_store_cannot_be_inside_the_pool_it_unlocks(self):
        for location in ("/", "relative", "/srv/../data", "/srv/teamaibox/phone-pools/keys"):
            value = plan()
            value["keyStore"]["encryptedRoot"] = location
            with self.subTest(location=location), self.assertRaises(pool.PoolError):
                pool.validate_plan(value)

    def test_host_identity_is_local_and_checked_before_storage(self):
        with patch.object(pool.socket, "gethostname", return_value="other"), patch.object(pool, "command") as command:
            with self.assertRaisesRegex(pool.PoolError, "wrong_host"):
                pool.host_check(plan())
            command.assert_not_called()

    def test_encrypted_key_store_is_verified_on_same_host(self):
        p = plan()
        def command(args):
            if args == ["findmnt", "-n", "-o", "UUID", "/"]:
                return p["appliance"]["rootFilesystemUUID"]
            if args[:4] == ["findmnt", "-n", "-o", "UUID"]:
                return p["keyStore"]["filesystemUUID"]
            if args[:4] == ["findmnt", "-n", "-o", "SOURCE"]:
                return "/dev/mapper/appliance-data"
            if args == ["cryptsetup", "status", "appliance-data"]:
                return "type: LUKS2\n"
            self.fail("unexpected operation: " + repr(args))
        with patch.object(pool.socket, "gethostname", return_value="local-appliance"), patch.object(pool, "no_links"), patch.object(pool, "command", side_effect=command):
            self.assertEqual(pool.key_store_root(p), Path("/srv/appliance-data/phone-pool-keys") / p["poolId"])

    def test_local_key_is_read_without_stdin_and_wiped_after_use(self):
        with tempfile.TemporaryDirectory() as directory:
            source, scratch = Path(directory)/"key", Path(directory)/"memfd"
            source.write_bytes(b"x" * 64)
            source.chmod(0o600)
            real_fstat = os.fstat
            def root_owned(fd):
                info = real_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink, st_size=info.st_size)
            libc = SimpleNamespace(mlock=lambda *_: 0, munlock=lambda *_: 0)
            with patch.object(pool, "key_path", return_value=source), patch.object(pool.resource, "setrlimit"), \
                 patch.object(pool.ctypes, "CDLL", return_value=libc), patch.object(pool.os, "fstat", side_effect=root_owned), \
                 patch.object(pool.os, "MFD_CLOEXEC", 1, create=True), \
                 patch.object(pool.os, "memfd_create", side_effect=lambda *_: os.open(scratch, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), create=True):
                with pool.local_key(plan()) as descriptor:
                    self.assertEqual(os.read(descriptor, 64), b"x" * 64)
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
            self.assertEqual(scratch.read_bytes(), b"\0" * 64)
            self.assertEqual(source.read_bytes(), b"x" * 64)

    def test_no_export_or_ssh_command_exists(self):
        for module in (pool, boot, growth, windows):
            source = Path(module.__file__).read_text()
            tree = ast.parse(source)
            strings = {item.value for item in ast.walk(tree) if isinstance(item, ast.Constant) and isinstance(item.value, str)}
            self.assertFalse({"ssh", "scp", "key-export", "custody-key-export", "primary"} & strings)
            self.assertNotIn("stdin_key", source)
        self.assertFalse(hasattr(boot, "remote"))
        self.assertFalse(hasattr(boot, "primary"))

    def test_boot_plan_requires_same_appliance(self):
        p = boot_plan()
        self.assertEqual(boot.validate_plan(p, p["stage"] + "/plan.json"), p)
        for extra in ({"version": 1}, {"sshTarget": "remote"}, {"primaryHost": "remote"}, {"nodeHost": "remote"}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                boot.validate_plan({**p, **extra}, p["stage"] + "/plan.json")

    def test_boot_and_pool_identity_must_match(self):
        p = {**boot_plan(), "poolFiles": {}, "poolHelper": "/local/helper", "poolPlan": "/local/plan"}
        module = SimpleNamespace(plan_read=lambda _: plan())
        with patch.object(boot, "verify_files"), patch.object(boot.importlib.util, "spec_from_file_location") as spec, \
             patch.object(boot.importlib.util, "module_from_spec", return_value=module):
            self.assertEqual(boot.pool_module(p)[1]["poolId"], p["poolId"])
            p["applianceHostname"] = "different"
            with self.assertRaisesRegex(RuntimeError, "local_pool_mismatch"):
                boot.pool_module(p)

    def test_windows_uses_local_plan_and_rejects_malformed_lab_id(self):
        p = {**plan(), "labId": "windows-arm64-storage-20261016-a1"}
        with patch.object(windows, "pool_plan_read", return_value=p):
            self.assertEqual(windows.plan_read(Path("/local/plan")), p)
        p["labId"] = "../../disk"
        with patch.object(windows, "pool_plan_read", return_value=p), self.assertRaises(Exception):
            windows.plan_read(Path("/local/plan"))

    def test_windows_key_store_cannot_depend_on_its_own_locked_pool(self):
        p = {**plan(), "labId": "windows-arm64-storage-20261016-a1"}
        p["keyStore"]["encryptedRoot"] = "/srv/teamaibox/windows-lab/" + p["labId"] + "/keys"
        with patch.object(windows, "pool_plan_read", return_value=p), self.assertRaisesRegex(Exception, "key_store_unlock_cycle"):
            windows.plan_read(Path("/local/plan"))

    def test_agent_images_do_not_bundle_enrollment(self):
        for relative in ("deploy/images/node-agent-prebuilt.Dockerfile", "deploy/images/node-agent-protected-office-rollout.Dockerfile", "deploy/application-catalog-e2e/NodeAgentMetrics.Dockerfile"):
            self.assertNotIn("node-enroll", (ROOT / relative).read_text())


if __name__ == "__main__":
    unittest.main()
