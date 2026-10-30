from __future__ import annotations

import copy
import json
import unittest

from tools.ci_database_smoke import locked_postgres_reference
from tools.validate_supply_chain import (
    ACTIONS,
    IMAGES,
    POLICY,
    WORKFLOWS,
    SupplyChainError,
    validate,
)


class SupplyChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = json.loads(POLICY.read_text(encoding="utf-8"))
        self.actions = json.loads(ACTIONS.read_text(encoding="utf-8"))
        self.images = json.loads(IMAGES.read_text(encoding="utf-8"))
        self.workflows = {
            path.name: path.read_text(encoding="utf-8")
            for path in sorted(WORKFLOWS.glob("*.yml"))
        }

    def test_committed_supply_chain_is_valid(self) -> None:
        summary = validate(self.policy, self.actions, self.images, self.workflows)
        self.assertEqual(summary["actions"], 9)
        self.assertEqual(summary["workflows"], 2)

    def test_rejects_mutable_action_tag(self) -> None:
        workflows = copy.deepcopy(self.workflows)
        workflows["ci.yml"] = workflows["ci.yml"].replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "actions/checkout@v7",
            1,
        )
        with self.assertRaisesRegex(SupplyChainError, "mutable action"):
            validate(self.policy, self.actions, self.images, workflows)

    def test_rejects_missing_signature_gate(self) -> None:
        policy = copy.deepcopy(self.policy)
        policy["release"]["signaturesRequired"] = False
        with self.assertRaisesRegex(SupplyChainError, "signaturesRequired"):
            validate(policy, self.actions, self.images, self.workflows)

    def test_rejects_mutable_foundation_image(self) -> None:
        images = copy.deepcopy(self.images)
        images["images"]["node-runtime"]["reference"] = "docker.io/library/node:24"
        with self.assertRaisesRegex(SupplyChainError, "platform digest"):
            validate(self.policy, self.actions, images, self.workflows)

    def test_database_smoke_uses_committed_arm64_digest(self) -> None:
        reference = locked_postgres_reference()
        self.assertEqual(reference, self.images["images"]["postgres"]["reference"])


if __name__ == "__main__":
    unittest.main()
