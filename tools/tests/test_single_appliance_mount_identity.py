import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("mount_identity", Path(__file__).parents[1] / "single_appliance_mount_identity.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MountIdentityTests(unittest.TestCase):
    def test_order_does_not_change_identity(self):
        values = [dict(Type="volume", Source="/a", Destination="/data", RW=True),
                  dict(Type="bind", Source="/b", Destination="/config", RW=False)]
        self.assertEqual(MODULE.mount_identity(values), MODULE.mount_identity(list(reversed(values))))

    def test_target_source_and_access_are_bound(self):
        value = dict(Type="volume", Source="/a", Destination="/data", RW=True)
        for key, changed in (("Type", "bind"), ("Source", "/b"), ("Destination", "/other"), ("RW", False)):
            self.assertNotEqual(MODULE.mount_identity([value]), MODULE.mount_identity([{**value, key: changed}]))
