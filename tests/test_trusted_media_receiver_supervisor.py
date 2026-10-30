"""Concrete supervisor lifecycle tests; doubles are not physical evidence."""
from datetime import datetime, timezone
import os
import threading
import time
import unittest

from services.trusted_media_service.receiver_supervisor import PairedReceiverSupervisor, ReceiverSupervisorError
from services.trusted_media_service.runtime_api import PRIVACY_POLICY

SESSION = "10000000-0000-4000-8000-000000000001"
SOURCE = "20000000-0000-4000-8000-000000000001"
VIEWER = "30000000-0000-4000-8000-000000000001"


class Callback:
    def __init__(self):
        self.streamed = []
        self.reject = False

    def pair_source(self, **request):
        return {"paired": True, "blocked": False}

    def mark_streaming(self, **request):
        if self.reject:
            raise RuntimeError("private callback details")
        self.streamed.append(request)
        return {"session_id": request["session_id"], "state": "streaming"}


class Receiver:
    def __init__(self, events):
        self.events, self.paired, self.alive = events, None, False
        self.fail_close = False

    def start(self, **request):
        self.events.append("receiver-start")
        self.alive = True

    def duplicate_media_readers(self):
        result = []
        for _ in range(2):
            reader, writer = os.pipe()
            os.close(writer)
            result.append(reader)
        return tuple(result)

    def authorized_source_id(self):
        return self.paired if self.alive else None

    def running(self):
        return self.alive

    def close(self):
        self.events.append("receiver-close")
        self.alive = False
        if self.fail_close:
            raise RuntimeError("private child diagnostic")


class Ingress:
    def __init__(self, **request):
        self.samples = {"video": [], "audio": []}
        self.closed = False
        self.discarded = 0

    def pull(self, media, **request):
        return self.samples[media].pop(0) if self.samples[media] else None

    def discard_pending(self):
        count = sum(len(values) for values in self.samples.values())
        for values in self.samples.values():
            values.clear()
        self.discarded += count
        return {"video": 0, "audio": count}

    def snapshot(self):
        return {}

    def close(self):
        self.closed = True


class Output:
    def __init__(self, events, name):
        self.events, self.name = events, name
        self.fail_start = self.fail_close = self.fail_push = False
        self.fail_health = False
        self.started = self.closed = False
        self.received = []
        self.disconnected = []
        self.code = "browser_sink"

    def start(self):
        self.events.append(self.name + "-start")
        self.started = True
        if self.fail_start:
            raise RuntimeError("private output detail")

    def push(self, media, sample):
        if self.fail_push:
            error = RuntimeError("private media detail")
            error.failure_code = self.code
            raise error
        self.received.append(media)

    def snapshot(self):
        if self.fail_health:
            return {"healthy": False, "state": "failed"}
        return {"healthy": bool(self.received) and not self.closed, "state": "waiting"}

    def failure_code(self):
        return self.code

    def close(self):
        self.events.append(self.name + "-close")
        if self.fail_close:
            raise RuntimeError("private cleanup detail")
        self.closed = True

    def disconnect_viewer(self, **request):
        self.disconnected.append(request)


class ReceiverSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.events, self.outputs, self.receivers = [], {}, []
        self.callback = Callback()
        def receiver():
            value = Receiver(self.events)
            self.receivers.append(value)
            return value
        self.supervisor = PairedReceiverSupervisor(callback_client=self.callback, clock=lambda: self.now,
            receiver_factory=receiver, ingress_factory=Ingress,
            output_factories={name: self.factory(name) for name in ("browser",)})
        self.addCleanup(self.cleanup)

    def factory(self, name):
        def build(**request):
            self.assertEqual(set(request), {"session_id", "expires_at"})
            self.outputs[name] = Output(self.events, name)
            return self.outputs[name]
        return build

    def request(self, sinks=("browser",)):
        return {"sessionId": SESSION, "receiverName": "Team-AI-0123456789", "pairingPin": "1234",
            "outputSinks": list(sinks), "browserStartsMuted": len(sinks) == 2, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
            "expiresAt": datetime.fromtimestamp(self.now + 120, timezone.utc).isoformat().replace("+00:00", "Z")}

    def cleanup(self):
        for output in self.outputs.values():
            output.fail_close = False
        for receiver in self.receivers:
            receiver.fail_close = False
        self.supervisor.stop({"sessionId": SESSION})

    def tick(self, media="video"):
        with self.supervisor._lock:
            active = self.supervisor._active
            active.ingress.samples[media].append(object())
            self.supervisor._tick(active)

    def test_admit_outputs_before_receiver_and_do_not_infer_streaming(self):
        self.supervisor.start(self.request())
        self.assertEqual(self.events[:2], ["browser-start", "receiver-start"])
        self.tick()
        self.assertEqual(self.callback.streamed, [])
        self.assertEqual(self.outputs["browser"].received, [])
        health = self.supervisor.health(SESSION)
        self.assertTrue(health["healthy"])
        self.assertFalse(health["outputs"]["browser"]["healthy"])
        self.receivers[0].paired = SOURCE
        self.tick()
        self.tick("audio")
        self.assertEqual(self.callback.streamed, [{"session_id": SESSION, "source_connection_id": SOURCE}])
        self.assertTrue(self.supervisor.health(SESSION)["outputs"]["browser"]["healthy"])

    def test_waiting_health_does_not_hide_a_dead_receiver_or_failed_output(self):
        with self.supervisor._lock:
            self.supervisor.start(self.request())
            self.assertTrue(self.supervisor.health(SESSION)["healthy"])
            self.receivers[0].alive = False
            self.assertFalse(self.supervisor.health(SESSION)["healthy"])
            self.receivers[0].alive = True
            self.outputs["browser"].fail_health = True
            self.assertFalse(self.supervisor.health(SESSION)["healthy"])

    def test_missing_hdmi_factory_fails_before_native_advertisement(self):
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.start(self.request(("hdmi",)))
        self.assertEqual(self.receivers, [])

    def test_terminal_reason_survives_cleanup_and_is_not_private_exception_text(self):
        from services.trusted_media_service.gdp_media_ingress import MediaIngressError
        with self.supervisor._lock:
            self.supervisor.start(self.request())
            self.receivers[0].paired = SOURCE
            def reject(*args, **kwargs):
                raise MediaIngressError("video_rate")
            self.supervisor._active.ingress.pull = reject
        self.wait_clean()
        health = self.supervisor.health(SESSION)
        self.assertEqual(health["receiverState"], "failed")
        self.assertEqual(health["failureCode"], "video_rate")
        self.assertFalse(health["healthy"])
        self.assertFalse(self.receivers[0].alive)
        self.supervisor.stop({"sessionId": SESSION})
        self.supervisor.start(self.request())
        self.assertNotIn("receiverState", self.supervisor.health(SESSION))

    def test_uncertain_output_start_cleanup_blocks_new_session(self):
        output = Output(self.events, "browser")
        output.fail_start = output.fail_close = True
        self.outputs["browser"] = output
        self.supervisor._factories["browser"] = lambda **_: output
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.start(self.request())
        self.assertEqual(self.receivers, [])
        self.assertIsNotNone(self.supervisor._active)
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.start(self.request())
        output.fail_close = False
        self.supervisor.stop({"sessionId": SESSION})
        self.assertIsNone(self.supervisor._active)

    def test_source_callback_failure_never_releases_media(self):
        self.supervisor.start(self.request())
        self.callback.reject = True
        self.receivers[0].paired = SOURCE
        with self.assertRaises(RuntimeError):
            self.tick()
        self.assertEqual(self.outputs["browser"].received, [])

    def test_versioned_source_stop_discards_stale_media_and_resume_uses_fresh_samples(self):
        self.supervisor.start(self.request())
        receiver = self.receivers[0]
        receiver.paired = SOURCE
        lifecycle = {"state": "connected", "revision": 2}
        receiver.source_state_snapshot = lambda: dict(lifecycle)
        active = self.supervisor._active
        active.ingress.samples["video"].append(object())
        self.supervisor._tick(active)
        self.assertEqual(self.outputs["browser"].received, ["video"])

        active.ingress.samples["video"].append(object())
        active.ingress.samples["audio"].append(object())
        lifecycle.update(state="disconnected", revision=3)
        self.supervisor._tick(active)
        self.assertEqual(active.ingress.discarded, 2)
        self.assertEqual(self.outputs["browser"].received, ["video"])
        self.assertEqual(self.supervisor.health(SESSION)["progress"]["sourceStateRevision"], 3)

        active.ingress.samples["video"].append(object())
        lifecycle.update(state="connected", revision=4)
        self.supervisor._tick(active)
        self.assertEqual(self.outputs["browser"].received, ["video", "video"])
        self.assertEqual(self.supervisor.health(SESSION)["progress"]["sourceState"], "connected")

    def test_physical_output_factory_cannot_be_configured(self):
        with self.assertRaises(ValueError):
            PairedReceiverSupervisor(callback_client=self.callback, receiver_factory=lambda: None,
                output_factories={"browser": self.factory("browser"), "hdmi": self.factory("hdmi")})

    def test_browser_health_failure_before_pairing_stops_receiver(self):
        with self.supervisor._lock:
            self.supervisor.start(self.request())
            self.outputs["browser"].fail_health = True
        self.wait_clean()
        self.assertFalse(self.receivers[0].alive)
        self.assertEqual(self.callback.streamed, [])

    def test_all_failed_outputs_abort_and_native_exit_cleans_each_owned_resource(self):
        self.supervisor.start(self.request())
        self.receivers[0].paired = SOURCE
        self.outputs["browser"].fail_push = True
        with self.assertRaises(ReceiverSupervisorError):
            self.tick()
        self.receivers[0].alive = False
        self.wait_clean()
        self.assertTrue(self.outputs["browser"].closed)

    def test_bounded_browser_failure_code_survives_output_cleanup(self):
        self.supervisor.start(self.request())
        self.receivers[0].paired = SOURCE
        self.outputs["browser"].fail_push = True
        self.outputs["browser"].code = "browser_pipeline_bus"
        with self.assertRaises(ReceiverSupervisorError) as caught:
            self.tick()
        self.assertEqual(caught.exception.failure_code, "browser_pipeline_bus")

    def wait_clean(self):
        deadline = time.monotonic() + 2
        while self.supervisor._active is not None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNone(self.supervisor._active)

    def test_ttl_cleanup_without_platform_request(self):
        self.supervisor.start(self.request())
        self.now += 121
        self.wait_clean()
        self.assertTrue(self.outputs["browser"].closed)
        self.assertFalse(self.receivers[0].alive)

    def test_stop_attempts_all_resources_and_retains_failed_handle(self):
        self.supervisor.start(self.request())
        self.receivers[0].fail_close = True
        self.outputs["browser"].fail_close = True
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.stop({"sessionId": SESSION})
        self.assertIsNotNone(self.supervisor._active)
        self.cleanup()
        self.assertIsNone(self.supervisor._active)

    def test_update_rejects_legacy_output_even_if_a_factory_is_injected(self):
        self.supervisor.start(self.request())
        output = Output(self.events, "hdmi")
        output.fail_start = True
        self.outputs["hdmi"] = output
        self.supervisor._factories["hdmi"] = lambda **_: output
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.update(self.request(("hdmi", "browser")))
        self.assertFalse(output.started)
        self.assertFalse(self.outputs["browser"].closed)
        self.assertEqual(set(self.supervisor._active.outputs), {"browser"})

    def test_update_remove_and_viewer_revocation_call_actual_sink_boundary(self):
        self.supervisor.start(self.request())
        self.supervisor.disconnect_viewer({"sessionId": SESSION, "viewerIdentityId": VIEWER})
        self.assertEqual(self.outputs["browser"].disconnected, [{"viewer_identity_id": VIEWER}])
        with self.assertRaises(ReceiverSupervisorError):
            self.supervisor.update(self.request(("hdmi",)))
        self.assertFalse(self.outputs["browser"].closed)

    def test_stop_during_inflight_callback_closes_receiver_before_late_reply(self):
        self.supervisor.start(self.request())
        entered, release = threading.Event(), threading.Event()
        def delayed(**request):
            entered.set()
            release.wait(2)
            return {"session_id": SESSION, "state": "streaming"}
        self.callback.mark_streaming = delayed
        with self.supervisor._lock:
            self.receivers[0].paired = SOURCE
            self.supervisor._active.ingress.samples["video"].append(object())
        self.assertTrue(entered.wait(1))
        closer = threading.Thread(target=lambda: self.supervisor.stop({"sessionId": SESSION}))
        closer.start()
        deadline = time.monotonic() + 1
        while self.receivers[0].alive and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.receivers[0].alive)
        release.set()
        closer.join(2)
        self.assertFalse(closer.is_alive())
        self.assertEqual(self.outputs["browser"].received, [])


if __name__ == "__main__":
    unittest.main()
