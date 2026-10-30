"""Assembly/lifecycle tests, not deployment or real-media acceptance."""
from datetime import datetime, timedelta, timezone
import unittest
import time
from unittest.mock import patch
from uuid import uuid4

from services.trusted_media_service.runtime_composition import BrowserMediaRuntime, TrustedMediaRuntime
from services.trusted_media_service.runtime_api import RuntimeApiError, PLATFORM_PEER, PRIVACY_POLICY


class Callback:
    def pair_source(self, **_): raise AssertionError("must not pair at construction")
    def mark_streaming(self, **_): raise AssertionError("must not stream at construction")


class Rooms:
    def __init__(self): self.closed = False
    def create(self, **_): raise AssertionError("must not create a room at construction")
    def remove_viewer(self, **_): raise AssertionError("no participant")
    def delete(self, **_): raise AssertionError("no room")
    def close(self): self.closed = True


class RuntimeCompositionTest(unittest.TestCase):
    def setUp(self):
        self.rooms = Rooms()
        self.config = dict(callback_client=Callback(), room_control=self.rooms, api_key="synthetic-key",
            api_secret="synthetic-test-secret-not-a-deployment-key", interface="eth0",
            private_publisher_endpoint="wss://127.0.0.1:7780", viewer_endpoint="wss://127.0.0.1:7781")

    def test_construction_and_shutdown_never_advertise_or_make_room(self):
        with patch("services.trusted_media_service.runtime_composition.DiscoverableReceiverProcess") as receiver:
            runtime = BrowserMediaRuntime(**self.config)
            self.assertIsNone(runtime.api._active)
            receiver.assert_not_called()
            runtime.close()
            self.assertTrue(self.rooms.closed)
            self.assertTrue(runtime._publisher._closed)
            self.assertTrue(runtime._viewers._closed)
            runtime.close()

    def test_unimplemented_hdmi_fails_before_receiver_or_room_allocation(self):
        with patch("services.trusted_media_service.runtime_composition.DiscoverableReceiverProcess") as receiver:
            runtime = BrowserMediaRuntime(**self.config)
            self.addCleanup(runtime.close)
            now = datetime.now(timezone.utc)
            with self.assertRaisesRegex(RuntimeApiError, "cast_runtime_output_invalid"):
                runtime.api.handle(peer_uri_san=PLATFORM_PEER, request_id=str(uuid4()),
                    issued_at=now.isoformat().replace("+00:00", "Z"), method="POST", path="/internal/v1/runtime/sessions",
                    body={"sessionId": str(uuid4()), "receiverName": "Team-AI-012ABC6789", "pairingPin": "9876",
                        "outputSinks": ["hdmi"], "browserStartsMuted": False, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
                        "expiresAt": (now + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")})
            receiver.assert_not_called()
            self.assertIsNone(runtime.api._active)

    def test_invalid_interface_is_rejected_without_owned_objects(self):
        with self.assertRaises(ValueError):
            BrowserMediaRuntime(**{**self.config, "interface": "eth0\nother-setting=yes"})
        self.assertFalse(self.rooms.closed)

    def test_legacy_hdmi_configuration_is_rejected_before_any_resource(self):
        for config in ({}, {"card": 1, "connector": "HDMI-A-1"}, False, "auto"):
            with self.subTest(config=config), patch("os.open", side_effect=AssertionError("no device open")):
                with self.assertRaisesRegex(ValueError, "cast_runtime_output_invalid"):
                    TrustedMediaRuntime(**self.config, hdmi=config)
        self.assertFalse(self.rooms.closed)

    def test_composition_imports_no_display_backend(self):
        import subprocess
        import sys
        result = subprocess.run([sys.executable, "-c",
            "import sys; import services.trusted_media_service.runtime_composition; "
            "assert 'services.trusted_media_service.hdmi_media_output' not in sys.modules; "
            "assert 'services.trusted_media_service.display_lease_client' not in sys.modules"],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
