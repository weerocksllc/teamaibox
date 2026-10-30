from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest

from tools.luks2_disposable_prototype import PrototypeFailure, execute, validate_identity


class FakeRunner:
    def __init__(self) -> None:
        self.slots: set[int] = set()
        self.commands: list[tuple[str, ...]] = []

    def run(self, arguments, *, timeout=120, check=True):
        args = tuple(arguments)
        self.commands.append(args)
        returncode = 0
        stdout = ""
        if args[0] == "truncate":
            Path(args[-1]).touch()
        elif args[:2] == ("cryptsetup", "luksFormat"):
            self.slots = {0}
        elif args[:2] == ("cryptsetup", "luksAddKey"):
            self.slots.add(int(args[args.index("--new-key-slot") + 1]))
        elif args[:2] == ("cryptsetup", "luksKillSlot"):
            self.slots.remove(int(args[-1]))
        elif args[:3] == ("cryptsetup", "luksDump", "--dump-json-metadata"):
            stdout = json.dumps({"keyslots": {str(slot): {"type": "luks2"} for slot in self.slots}})
        elif args[:3] == ("cryptsetup", "open", "--test-passphrase"):
            key_path = args[args.index("--key-file") + 1]
            if key_path.endswith("automatic-v1.key"):
                returncode = 0 if 0 in self.slots else 2
            elif key_path.endswith("automatic-v2.key"):
                returncode = 0 if 3 in self.slots else 2
            elif key_path.endswith("web-passphrase.key"):
                returncode = 0 if 2 in self.slots else 2
            elif key_path.endswith("wrong-passphrase.key"):
                returncode = 2
        result = subprocess.CompletedProcess(args, returncode, stdout, "")
        if check and returncode != 0:
            raise AssertionError(args)
        return result


class Luks2DisposablePrototypeTests(unittest.TestCase):
    def test_complete_lifecycle_uses_only_the_guarded_sparse_file(self) -> None:
        run_id = "luks2-prototype-20991231-unit-a1"
        work, _ = validate_identity(run_id)
        self.assertFalse(work.exists())
        runner = FakeRunner()
        result = execute(run_id, size_mib=512, runner=runner)
        self.assertEqual(result["initialSlots"], [0, 1, 2])
        self.assertEqual(result["finalSlots"], [1, 3])
        self.assertTrue(all(result["checks"].values()))
        self.assertTrue(result["cleanup"]["passed"])
        self.assertFalse(work.exists())
        serialized = "\n".join(" ".join(command) for command in runner.commands)
        self.assertNotIn("/dev/nvme", serialized)
        self.assertNotIn("/dev/sda", serialized)

    def test_identity_and_size_cannot_select_an_arbitrary_device(self) -> None:
        for value in ("bad", "luks2-prototype-20260812-../../root", "/dev/nvme0n1"):
            with self.assertRaises(PrototypeFailure):
                validate_identity(value)
        with self.assertRaisesRegex(PrototypeFailure, "between 512"):
            execute("luks2-prototype-20991231-size-a1", size_mib=128, runner=FakeRunner())


if __name__ == "__main__":
    unittest.main()
