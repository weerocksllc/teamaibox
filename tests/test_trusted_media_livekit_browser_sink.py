"""Browser sink lifecycle/failure tests, not product media acceptance."""
from datetime import datetime, timezone
import time
import unittest
from uuid import uuid4
from unittest.mock import Mock

from services.trusted_media_service.livekit_browser_sink import LiveKitBrowserSink, BrowserSinkError
from services.trusted_media_service.publisher_credentials import PublisherCredentialIssuer
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer, ViewerTokenError
from services.trusted_media_service.webrtc_media_output import MediaOutputError, WebRtcMediaOutput

SESSION = "10000000-0000-4000-8000-000000000001"
VIEWER = "20000000-0000-4000-8000-000000000001"


class Room:
    def __init__(self):
        self.events = []
        self.fail_create = self.fail_delete = self.fail_remove = False

    def create(self, **request):
        self.events.append("create")
        self.create_request = request
        if self.fail_create:
            raise RuntimeError("private control detail")

    def remove_viewer(self, **request):
        self.events.append("remove")
        if self.fail_remove:
            raise RuntimeError("private control detail")

    def delete(self, **request):
        self.events.append("delete")
        if self.fail_delete:
            raise RuntimeError("private control detail")


class Output:
    def __init__(self, **request):
        self.closed = False
        self.fail_close = False
        self.fail_push = False
        self.code = "browser_output"

    def push(self, media, sample):
        if self.fail_push:
            raise MediaOutputError(self.code)

    def snapshot(self):
        return {"healthy": False, "state": "waiting"}

    def failure_code(self):
        return self.code

    def close(self):
        if self.fail_close:
            raise RuntimeError("private publisher detail")
        self.closed = True


class BrowserSinkTest(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.room, self.output = Room(), Output()
        self.publisher = PublisherCredentialIssuer(api_key="test-key", api_secret="s" * 32,
            endpoint="wss://localhost:7880", clock=lambda: self.now)
        self.viewers = LiveKitViewerTokenIssuer(api_key="test-key", api_secret="s" * 32,
            endpoint="wss://localhost:7880", clock=lambda: self.now)
        self.sink = LiveKitBrowserSink(session_id=SESSION, expires_at=self.now + 120,
            room_control=self.room, publisher_issuer=self.publisher, viewer_issuer=self.viewers,
            output_factory=lambda **_: self.output)
        self.addCleanup(self.publisher.close)

    def issue(self, viewer=VIEWER, browser="browser-instance-0001"):
        request = dict(session_id=SESSION, viewer_identity_id=viewer, grant_id=str(uuid4()), audience_revision=1,
            browser_instance_id=browser, muted=False, maximum_viewers=8, publisher_encode_renditions=1,
            grant_expires_at=datetime.fromtimestamp(self.now + 90, timezone.utc).isoformat().replace("+00:00", "Z"))
        value = self.viewers.issue(**request)
        self.viewers.consume(value["accessToken"], session_id=SESSION,
                             viewer_identity_id=viewer, browser_instance_id=request["browser_instance_id"])
        return value

    def test_scoped_disconnect_after_jwt_expiry_preserves_another_browser_and_failed_removal_retries(self):
        self.sink.start()
        self.issue(browser="browser-instance-one")
        self.issue(browser="browser-instance-two")
        targets = []
        original = self.room.remove_viewer
        self.room.remove_viewer = lambda **request: (targets.append(request), original(**request))[-1]
        one = self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER,
            browser_instance_id="browser-instance-one")
        two = self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER,
            browser_instance_id="browser-instance-two")
        self.assertEqual(len(one), 1)
        self.assertEqual(len(two), 1)
        self.assertNotEqual(one, two)
        self.now += 31
        self.assertEqual(self.viewers.status()["activeAdmissionCount"], 0)
        self.room.fail_remove = True
        with self.assertRaises(BrowserSinkError):
            self.sink.disconnect_viewer(viewer_identity_id=VIEWER, browser_instance_id="browser-instance-one")
        self.assertEqual(len(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER)), 2)
        self.room.fail_remove = False
        self.sink.disconnect_viewer(viewer_identity_id=VIEWER, browser_instance_id="browser-instance-one")
        self.assertEqual(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER), two)
        self.assertTrue(all(target["participant_identity"] == one[0] for target in targets))
        self.sink.disconnect_viewer(viewer_identity_id=VIEWER)
        self.assertEqual(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER), ())
        self.sink.close()

    def test_jwt_expiry_does_not_hide_a_live_participant_from_disconnect(self):
        self.sink.start()
        self.assertEqual(self.room.create_request, dict(session_id=SESSION, expires_at=self.now + 120))
        self.issue()
        self.now += 31
        self.assertEqual(self.viewers.status()["activeAdmissionCount"], 0)
        self.assertEqual(len(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER)), 1)
        self.sink.disconnect_viewer(viewer_identity_id=VIEWER)
        self.assertEqual(self.room.events, ["create", "remove"])
        self.assertEqual(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER), ())
        self.sink.close()

    def test_connections_remain_accounted_after_token_expiry_without_eight_viewer_cap(self):
        self.sink.start()
        for _ in range(8):
            self.issue(str(uuid4()))
        self.now += 31
        self.issue(str(uuid4()))
        self.assertEqual(len(self.viewers._connections), 9)
        self.sink.close()
        self.assertEqual(self.viewers._connections, {})

    def test_uncertain_participant_removal_retains_accounting_for_retry(self):
        self.sink.start()
        self.issue()
        self.room.fail_remove = True
        with self.assertRaises(BrowserSinkError):
            self.sink.disconnect_viewer(viewer_identity_id=VIEWER)
        self.assertEqual(len(self.viewers.connected_participants(session_id=SESSION, viewer_identity_id=VIEWER)), 1)
        self.room.fail_remove = False
        self.sink.disconnect_viewer(viewer_identity_id=VIEWER)
        self.sink.close()

    def test_uncertain_create_is_owned_and_deleted(self):
        self.room.fail_create = True
        with self.assertRaises(BrowserSinkError):
            self.sink.start()
        with self.assertRaises(BrowserSinkError):
            self.sink.push("video", object())
        self.sink.close()
        self.assertEqual(self.room.events, ["create", "delete"])

    def test_failed_publisher_stop_still_deletes_room_and_retains_handle(self):
        self.sink.start()
        self.sink.push("video", object())
        self.output.fail_close = True
        with self.assertRaises(BrowserSinkError):
            self.sink.close()
        self.assertEqual(self.room.events, ["create", "delete"])
        self.assertIs(self.sink._output, self.output)
        self.output.fail_close = False
        self.sink.close()
        self.sink.close()

    def test_failed_room_delete_still_stops_publisher_and_retries_room(self):
        self.sink.start()
        self.sink.push("video", object())
        self.room.fail_delete = True
        with self.assertRaises(BrowserSinkError):
            self.sink.close()
        self.assertTrue(self.output.closed)
        self.assertTrue(self.sink._room_owned)
        self.room.fail_delete = False
        self.sink.close()
        self.assertEqual(self.room.events, ["create", "delete", "delete"])

    def test_waiting_eighteen_minutes_issues_fresh_credential_only_at_first_media(self):
        factory = Mock(return_value=self.output)
        sink = LiveKitBrowserSink(session_id=SESSION, expires_at=self.now + 1800,
            room_control=self.room, publisher_issuer=self.publisher, viewer_issuer=self.viewers,
            output_factory=factory)
        sink.start()
        factory.assert_not_called()
        self.assertEqual(sink.snapshot(), {"healthy": False, "state": "waiting"})
        self.now += 18 * 60
        sink.push("video", object())
        credential = factory.call_args.kwargs["credential"]
        self.assertEqual(credential.expires_at, int(self.now) + 30)
        self.assertEqual(credential.room, "cast-" + SESSION.replace("-", ""))
        sink.push("audio", object())
        factory.assert_called_once()
        sink.close()

    def test_stop_while_waiting_never_constructs_publisher(self):
        self.sink._output_factory = Mock()
        self.sink.start()
        self.sink.close()
        self.sink._output_factory.assert_not_called()
        self.assertEqual(self.room.events, ["create", "delete"])
        self.assertEqual(self.sink.snapshot()["state"], "closed")

    def test_push_before_start_is_rejected(self):
        with self.assertRaises(BrowserSinkError):
            self.sink.push("video", object())
        self.assertEqual(self.room.events, [])

    def test_expired_session_cannot_acquire_publisher(self):
        self.sink._output_factory = Mock()
        self.sink.start()
        self.now += 121
        with self.assertRaises(BrowserSinkError):
            self.sink.push("video", object())
        self.sink._output_factory.assert_not_called()
        self.assertEqual(self.sink.snapshot()["state"], "failed")
        self.sink.close()

    def test_constructor_failure_is_terminal_without_hidden_retry(self):
        self.sink._output_factory = Mock(side_effect=RuntimeError("private detail"))
        self.sink.start()
        for _ in range(2):
            with self.assertRaisesRegex(BrowserSinkError, "^cast_browser_sink_unavailable$"):
                self.sink.push("video", object())
        self.sink._output_factory.assert_called_once()
        self.assertEqual(self.sink.snapshot()["state"], "failed")
        self.sink.close()

    def test_bounded_publisher_failure_code_survives_sink_cleanup(self):
        self.sink.start()
        self.output.fail_push = True
        self.output.code = "browser_pipeline_bus"
        with self.assertRaises(BrowserSinkError) as caught:
            self.sink.push("video", object())
        self.assertEqual(caught.exception.failure_code, "browser_pipeline_bus")
        self.assertEqual(self.sink.failure_code(), "browser_pipeline_bus")
        self.sink.close()

    def test_bus_failure_classification_never_exposes_private_error_text(self):
        class Factory:
            def get_name(self): return "livekitwebrtcsink"
        class Source:
            def get_factory(self): return Factory()
        class SecretError:
            domain = "gst-resource-error-quark"
            def __str__(self): return "wss://private/token.private.value"
        class Message:
            src = Source()
            def parse_error(self): return SecretError(), "private debug"
        self.assertEqual(WebRtcMediaOutput._bus_failure_code(Message()), "browser_sfu")

    def test_bus_error_from_non_element_still_preserves_error_domain(self):
        error = Mock(domain="gst-resource-error-quark")
        message = Mock(src=object())
        message.parse_error.return_value = (error, "private detail")
        self.assertEqual(WebRtcMediaOutput._bus_failure_code(message), "browser_sfu")


if __name__ == "__main__":
    unittest.main()
