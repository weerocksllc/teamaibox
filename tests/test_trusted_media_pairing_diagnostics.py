"""Socketpair diagnostics on final runtime (no build compiler required)."""
import unittest
from tests.test_trusted_media_native_pairing_bridge import PairingBridgeTest


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PairingBridgeTest(name) for name in
        loader.getTestCaseNames(PairingBridgeTest)
        if name != "test_native_code_waits_for_platform_acceptance_over_real_socketpair")
