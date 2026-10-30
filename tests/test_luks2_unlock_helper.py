from __future__ import annotations

import unittest

from tools.luks2_unlock_helper import DisposableLuksVolume, UnlockHelperError, configuration


class FakeResult:
    def __init__(self, returncode=0):
        self.returncode = returncode


class FakeRunner:
    def __init__(self):
        self.commands = []
        self.mapped = False
        self.mounted = False

    def run(self, arguments, *, input_bytes=None, timeout=120, check=True):
        args = tuple(arguments)
        self.commands.append((args, None if input_bytes is None else len(input_bytes), timeout, check))
        if args[:2] == ("mountpoint", "-q"):
            return FakeResult(0 if self.mounted else 1)
        if args[:2] == ("cryptsetup", "open"):
            if input_bytes == bytearray(b"correct horse battery staple"):
                self.mapped = True
                return FakeResult(0)
            return FakeResult(2)
        if args[0] == "mount":
            self.mounted = True
        if args[:2] == ("cryptsetup", "close"):
            self.mapped = False
        return FakeResult(0)


class FakeMapped:
    def __init__(self, runner):
        self.runner = runner

    def exists(self):
        return self.runner.mapped


class Luks2UnlockHelperTests(unittest.TestCase):
    def test_identity_selects_only_one_disposable_regular_file_boundary(self):
        value = configuration("luks-unlock-integration-20991231-unit-a1")
        self.assertEqual(str(value["root"]), "/tmp/teamaibox-luks-unlock-integration-20991231-unit-a1")
        self.assertEqual(value["image"], value["root"] / "volume.img")
        self.assertEqual(value["mount"], value["root"] / "mount")
        self.assertEqual(value["socket"], value["root"] / "helper.sock")
        self.assertTrue(value["mapper"].startswith("teamaibox-luks-unlock-"))

    def test_identity_rejects_device_paths_and_traversal(self):
        for value in ("bad", "/dev/nvme0n1", "luks-unlock-integration-20260821-../../root"):
            with self.assertRaises(UnlockHelperError):
                configuration(value)

    def test_wrong_factor_fails_and_bytes_are_not_placed_in_arguments(self):
        runner = FakeRunner()
        volume = DisposableLuksVolume("luks-unlock-integration-20991231-unit-a2", runner)
        volume.paths["mapped"] = FakeMapped(runner)
        factor = bytearray(b"wrong factor")
        self.assertEqual(volume.unlock(factor), {"accepted": False})
        command = next(item for item in runner.commands if item[0][:2] == ("cryptsetup", "open"))
        self.assertNotIn("wrong factor", " ".join(command[0]))
        self.assertEqual(command[1], len(factor))

    def test_correct_factor_mounts_with_hardened_options(self):
        runner = FakeRunner()
        volume = DisposableLuksVolume("luks-unlock-integration-20991231-unit-a3", runner)
        volume.paths["mapped"] = FakeMapped(runner)
        factor = bytearray(b"correct horse battery staple")
        self.assertEqual(volume.unlock(factor), {"accepted": True})
        mount = next(item[0] for item in runner.commands if item[0][0] == "mount")
        self.assertEqual(mount[1:3], ("-o", "nodev,nosuid,noexec"))
        self.assertNotIn(factor.decode(), " ".join(mount))


if __name__ == "__main__":
    unittest.main()
