from __future__ import annotations

import copy
import json
import unittest

from tools.validate_production_image_catalog import (
    CATALOG,
    ProductionImageCatalogError,
    validate,
)


class ProductionImageCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    def test_committed_catalog_covers_current_non_root_production_images(self) -> None:
        self.assertEqual(validate(self.catalog), {
            "components": 14,
            "supplyChainTools": 2,
            "requiredEvidencePerComponent": 9,
        })

    def test_foundation_stub_or_root_runtime_fails_closed(self) -> None:
        value = copy.deepcopy(self.catalog)
        value["components"][0]["dockerfile"] = "deploy/images/foundation-node.Dockerfile"
        with self.assertRaisesRegex(ProductionImageCatalogError, "foundation stub"):
            validate(value)
        value = copy.deepcopy(self.catalog)
        node = next(item for item in value["components"] if item["key"] == "node-agent")
        node["runtimeUser"] = "0:0"
        with self.assertRaisesRegex(ProductionImageCatalogError, "runtime user|non-root"):
            validate(value)

    def test_build_host_network_cannot_become_runtime_network(self) -> None:
        value = copy.deepcopy(self.catalog)
        value["runtimeNetwork"] = "host"
        with self.assertRaisesRegex(ProductionImageCatalogError, "runtime network"):
            validate(value)

    def test_missing_signature_or_component_evidence_fails_closed(self) -> None:
        value = copy.deepcopy(self.catalog)
        value["supplyChain"]["signatureArm64Image"] = "gcr.io/projectsigstore/cosign:latest"
        with self.assertRaisesRegex(ProductionImageCatalogError, "not digest pinned"):
            validate(value)
        value = copy.deepcopy(self.catalog)
        value["completionEvidence"]["requiredPerComponent"].remove("healthCheck")
        with self.assertRaisesRegex(ProductionImageCatalogError, "completion evidence"):
            validate(value)


if __name__ == "__main__":
    unittest.main()
