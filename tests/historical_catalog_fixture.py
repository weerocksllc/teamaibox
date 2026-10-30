"""Frozen input for v1-v22 catalog transformation unit tests.

These tests exercise the original 44-feature baseline, not today's deployment.
The production validator still reads current sources and rejects incomplete
coverage. No evidence file or acceptance state is updated by this fixture.
"""
import copy
import unittest
import sys
from unittest.mock import patch
from tools import validate_feature_acceptance_catalog as catalog


class HistoricalCatalogTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        fixture = copy.deepcopy(catalog.EXPECTED_COVERAGE)
        # Older tools import the same module without the tools package prefix.
        modules = {catalog, sys.modules.get('validate_feature_acceptance_catalog')}
        for module in modules - {None}:
            scoped = patch.object(module, 'source_coverage', return_value=fixture)
            scoped.start()
            cls.addClassCleanup(scoped.stop)
