"""Least-privilege test bootstrap; never touch real host device permissions."""
from contextlib import ExitStack
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from probe_trusted_media_hdmi import prepare_private_devices


class PrivateDeviceBootstrapTests(unittest.TestCase):
    def setup_fakes(self, stack, *, bind=False, foreign_inode=False, capabilities="0"):
        mounts = "1 0 0:10 / /dev rw - tmpfs tmpfs rw\n"
        if bind:
            mounts += "2 1 0:11 /dri/card1 /dev/dri/card1 rw - devtmpfs devtmpfs rw\n"
        proc = "CapEff: " + capabilities + "\nCapPrm: " + capabilities + "\nNoNewPrivs: 1\n"
        # A descriptor-style patch passes self, keeping mount and status reads separate.
        stack.enter_context(patch.object(Path, "read_text", lambda path: mounts if str(path).endswith("mountinfo") else proc))
        stack.enter_context(patch("os.getuid", side_effect=[0, 65532, 65532]))
        stack.enter_context(patch("os.geteuid", return_value=65532))
        stack.enter_context(patch("os.getgid", return_value=65532))
        stack.enter_context(patch("os.stat", return_value=SimpleNamespace(st_dev=10)))
        stack.enter_context(patch("os.lstat", side_effect=[SimpleNamespace(st_mode=stat.S_IFCHR | 0o600,
            st_dev=11 if foreign_inode else 10, st_uid=0, st_gid=group, st_rdev=device)
            for group, device in ((44, 226001), (29, 116002), (29, 116007))]))
        stack.enter_context(patch("os.major", side_effect=lambda device: device // 1000))
        stack.enter_context(patch("os.minor", side_effect=lambda device: device % 1000))
        calls = {name: stack.enter_context(patch("os." + name)) for name in ("chmod", "setgroups", "setgid", "setuid")}
        return calls

    def test_private_nodes_then_drop_root_and_all_capabilities(self):
        with ExitStack() as stack:
            calls = self.setup_fakes(stack)
            result = prepare_private_devices()
            self.assertEqual(result["uid"], 65532)
            self.assertEqual(result["effectiveCapabilities"], 0)
            self.assertEqual(calls["chmod"].call_count, 3)
            calls["setgroups"].assert_called_once_with([29, 44])
            calls["setgid"].assert_called_once_with(65532)
            calls["setuid"].assert_called_once_with(65532)

    def test_host_bind_mount_refused_before_chmod(self):
        with ExitStack() as stack:
            calls = self.setup_fakes(stack, bind=True)
            with self.assertRaises(AssertionError):
                prepare_private_devices()
            calls["chmod"].assert_not_called()

    def test_non_private_inode_refused_before_chmod(self):
        with ExitStack() as stack:
            calls = self.setup_fakes(stack, foreign_inode=True)
            with self.assertRaises(AssertionError):
                prepare_private_devices()
            calls["chmod"].assert_not_called()

    def test_retained_capabilities_refused(self):
        with ExitStack() as stack:
            self.setup_fakes(stack, capabilities="80")
            with self.assertRaises(AssertionError):
                prepare_private_devices()


if __name__ == "__main__":
    unittest.main()
