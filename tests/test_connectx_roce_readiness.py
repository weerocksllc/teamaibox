from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile
import unittest

from tools.connectx_roce_readiness_probe import probe
from tools.validate_connectx_roce_evidence import validate_local_preflight
from tools.validate_connectx_roce_readiness_suite import validate as validate_suite


def write(path: pathlib.Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def fake_sys(root: pathlib.Path, *, up: bool) -> None:
    interface = root / "class/net/cx0"
    write(interface / "operstate", "up\n" if up else "down\n")
    write(interface / "carrier", "1\n" if up else "0\n")
    write(interface / "speed", "100000\n" if up else "-1\n")
    write(interface / "mtu", "9000\n" if up else "1500\n")
    write(interface / "device/vendor", "0x15b3\n")
    write(interface / "device/device", "0x1021\n")
    driver = root / "bus/pci/drivers/mlx5_core"
    driver.mkdir(parents=True)
    (interface / "device/driver").symlink_to(driver, target_is_directory=True)
    write(root / "class/infiniband/mlx5_0/device/net/cx0", "")
    write(root / "class/infiniband/mlx5_0/ports/1/state", "4: ACTIVE\n" if up else "1: DOWN\n")
    write(root / "class/infiniband/mlx5_0/ports/1/phys_state", "5: LinkUp\n" if up else "3: Disabled\n")
    write(root / "class/infiniband/mlx5_0/ports/1/link_layer", "Ethernet\n")
    write(root / "class/infiniband/mlx5_0/ports/1/gid_attrs/types/0", "RoCE v2\n")


def ip_runner(*_args, **_kwargs):
    return subprocess.CompletedProcess([], 0, json.dumps([{"addr_info": [{"family": "inet", "scope": "global", "local": "not-retained"}]}]), "")


class ConnectxRoceReadinessTests(unittest.TestCase):
    def test_suite_requires_every_link_rdma_topology_and_collective_gate(self) -> None:
        result = validate_suite()
        self.assertEqual(result["gateCount"], 9)
        self.assertTrue(result["suiteDigest"].startswith("sha256:"))

    def test_ready_local_facts_still_cannot_enable_distributed_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            fake_sys(root, up=True)
            result = probe(["cx0"], sys_root=root, runner=ip_runner, observed_at="2026-08-11T09:00:00Z")
        self.assertTrue(result["localPreflightPassed"])
        self.assertFalse(result["distributedProfilesEligible"])
        self.assertEqual(result["gates"][-1]["status"], "requires-peer-qualification")
        self.assertNotIn("not-retained", json.dumps(result))
        self.assertTrue(validate_local_preflight(result)["valid"])

    def test_down_link_blocks_every_dependent_gate_without_mutating_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            fake_sys(root, up=False)
            result = probe(["cx0"], sys_root=root, runner=ip_runner, observed_at="2026-08-11T09:00:00Z")
        self.assertFalse(result["localPreflightPassed"])
        self.assertEqual(result["gates"][0]["status"], "failed")
        self.assertTrue(all(item["status"] == "blocked" for item in result["gates"][1:5]))
        self.assertFalse(result["hostMutationPerformed"])
        self.assertFalse(validate_local_preflight(result)["distributedProfilesEligible"])

    def test_evidence_with_identity_or_profile_enablement_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            fake_sys(root, up=False)
            result = probe(["cx0"], sys_root=root, runner=ip_runner)
        result["hostname"] = "forbidden"
        with self.assertRaisesRegex(ValueError, "identity"):
            validate_local_preflight(result)
        result.pop("hostname")
        result["distributedProfilesEligible"] = True
        with self.assertRaisesRegex(ValueError, "enabled"):
            validate_local_preflight(result)


if __name__ == "__main__":
    unittest.main()
