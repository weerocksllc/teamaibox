from __future__ import annotations

import copy
import json
import unittest

from tools.validate_event_contracts import ENVELOPE, TOPOLOGY, EventContractError, validate


class EventContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.topology = json.loads(TOPOLOGY.read_text(encoding="utf-8"))
        self.envelope = json.loads(ENVELOPE.read_text(encoding="utf-8"))

    def test_committed_contracts_are_valid(self) -> None:
        summary = validate(self.topology, self.envelope)
        self.assertEqual(summary["streams"], 2)

    def test_rejects_non_durable_storage(self) -> None:
        topology = copy.deepcopy(self.topology)
        topology["streams"][0]["storage"] = "memory"
        with self.assertRaisesRegex(EventContractError, "file storage"):
            validate(topology, self.envelope)

    def test_rejects_implicit_ack(self) -> None:
        topology = copy.deepcopy(self.topology)
        topology["consumerDefaults"]["ackPolicy"] = "none"
        with self.assertRaisesRegex(EventContractError, "explicit ack"):
            validate(topology, self.envelope)

    def test_rejects_missing_event_id(self) -> None:
        envelope = copy.deepcopy(self.envelope)
        envelope["required"].remove("eventId")
        with self.assertRaisesRegex(EventContractError, "incomplete"):
            validate(self.topology, envelope)


if __name__ == "__main__":
    unittest.main()

