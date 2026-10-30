from __future__ import annotations

import json
import unittest

from tools.provision_nats_topology import DEFAULT_TOPOLOGY, _drift, desired_stream_config


class NatsTopologyProvisionerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.topology = json.loads(DEFAULT_TOPOLOGY.read_text(encoding="utf-8"))

    def test_maps_seconds_to_jetstream_nanoseconds(self) -> None:
        desired = desired_stream_config(self.topology, self.topology["streams"][0])
        self.assertEqual(desired["max_age"], 2_592_000_000_000_000)
        self.assertEqual(desired["duplicate_window"], 120_000_000_000)
        self.assertEqual(desired["num_replicas"], 1)

    def test_detects_critical_stream_drift(self) -> None:
        desired = desired_stream_config(self.topology, self.topology["streams"][0])
        actual = dict(desired)
        actual["storage"] = "memory"
        actual["subjects"] = ["unexpected.>"]
        self.assertEqual(_drift(desired, actual), ["subjects", "storage"])

    def test_accepts_exact_stream_config(self) -> None:
        desired = desired_stream_config(self.topology, self.topology["streams"][1])
        self.assertEqual(_drift(desired, desired), [])


if __name__ == "__main__":
    unittest.main()

