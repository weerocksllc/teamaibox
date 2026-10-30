import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("boot", ROOT / "tools/restore_existing_business_volumes.py")
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootVolumeTests(unittest.TestCase):
    def test_exact_scope_excludes_physical_disk(self):
        self.assertEqual(len(boot.VOLUMES), 2)
        self.assertTrue(all(v["root"].startswith("/tmp/teamaibox-luks-") for v in boot.VOLUMES))

    def test_mount_identity_and_security_fail_closed(self):
        v = boot.VOLUMES[0]
        ok = {"source": "/dev/mapper/" + v["mapper"], "target": v["root"] + "/mount",
              "fstype": "ext4", "uuid": v["fsUuid"], "options": "rw,nodev,nosuid,noexec,relatime"}
        boot.verify_mount(v, ok)
        for key, value in [("source", "/dev/sda1"), ("uuid", "other"), ("fstype", "tmpfs"),
                           ("target", "/tmp/other"), ("options", "rw")]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                boot.verify_mount(v, {**ok, key: value})
        with self.assertRaises(RuntimeError):
            boot.verify_mount(v, None)

    def test_wrong_backing_file_rejected(self):
        with patch.object(boot, "run", side_effect=["  device: /dev/loop6", '{"loopdevices":[{"back-file":"/wrong"}]}']):
            with self.assertRaisesRegex(RuntimeError, "backing_file"):
                boot.verify_mapper(boot.VOLUMES[0])

    def test_policy_change_rejected(self):
        with patch.object(Path, "exists", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "policy_changed"):
                boot.verify_policy(boot.VOLUMES[0]["root"])

    def test_no_format_factor_change_or_physical_device_operations(self):
        source = (ROOT / "tools/restore_existing_business_volumes.py").read_text()
        for prohibited in ("luksFormat", "mkfs", "luksAddKey", "luksKillSlot", "recovery.key", "/dev/sd", "shutil"):
            self.assertNotIn(prohibited, source)
        self.assertIn('"--key-slot", "0"', source)

    def test_ordering_and_fail_closed_docker_guard(self):
        unit = (ROOT / "deploy/host/teamaibox-existing-business-volumes.service").read_text()
        dropin = (ROOT / "deploy/host/docker-existing-business-volumes.conf").read_text()
        self.assertIn("Before=docker.service", unit)
        self.assertIn("Requires=teamaibox-existing-business-volumes.service", dropin)
        self.assertIn(" --check", dropin)


if __name__ == "__main__":
    unittest.main()
