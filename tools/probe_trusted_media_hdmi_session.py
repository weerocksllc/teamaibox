"""Network-isolated synthetic GDP -> production supervisor -> actual HDMI test.

The source and Platform callback are explicit test doubles. No UxPlay, LAN
advertisement, Apple pairing, authenticated browser or product claim is made.
Only generated moving video/tone are used, and no PCM/frame is retained.
"""
import argparse
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import time
from uuid import uuid4

from services.trusted_media_service.gdp_media_ingress import _gstreamer
from services.trusted_media_service.runtime_composition import TrustedMediaRuntime, HdmiDeviceConfig
from services.trusted_media_service.runtime_api import PLATFORM_PEER, PRIVACY_POLICY
from tools.probe_trusted_media_hdmi import prepare_private_devices


class NoRooms:
    def create(self, **_): raise AssertionError("HDMI-only must not create an SFU room")
    def remove_viewer(self, **_): raise AssertionError("no viewer")
    def delete(self, **_): raise AssertionError("no room")
    def close(self): pass


class SyntheticCallback:
    def __init__(self): self.streamed = 0
    def pair_source(self, **_): raise AssertionError("no Apple pairing in this test")
    def mark_streaming(self, **request):
        self.streamed += 1
        return {"state": "streaming", "session_id": request["session_id"]}


class SyntheticGdpSource:
    def __init__(self):
        self.Gst = _gstreamer()
        self.pipeline = None
        self.fds = []
        self.closed = False

    def start(self, **_):
        for _ in range(2): self.fds.extend(os.pipe())
        self.pipeline = self.Gst.parse_launch(
            "videotestsrc is-live=true pattern=ball ! capsfilter name=geometry "
            "caps=video/x-raw,format=I420,width=1920,height=1080,framerate=30/1 "
            f"! gdppay ! fdsink fd={self.fds[1]} sync=false "
            "audiotestsrc is-live=true volume=0.01 freq=440 ! "
            "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved "
            f"! gdppay ! fdsink fd={self.fds[3]} sync=false")
        if self.pipeline.set_state(self.Gst.State.PLAYING) == self.Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("synthetic source unavailable")

    def portrait(self):
        self.pipeline.get_by_name("geometry").set_property("caps", self.Gst.Caps.from_string(
            "video/x-raw,format=I420,width=540,height=960,framerate=30/1"))

    def duplicate_media_readers(self): return os.dup(self.fds[0]), os.dup(self.fds[2])
    def authorized_source_id(self): return "20000000-0000-4000-8000-000000000001"
    def running(self):
        return not self.closed and self.pipeline is not None and self.pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR) is None
    def close(self):
        if self.pipeline is not None:
            self.pipeline.set_state(self.Gst.State.NULL)
            if self.pipeline.get_state(self.Gst.SECOND)[1] != self.Gst.State.NULL:
                raise RuntimeError("synthetic cleanup incomplete")
            self.pipeline = None
        while self.fds: os.close(self.fds.pop())
        self.closed = True


def run(seconds):
    assert type(seconds) is int and 10 <= seconds <= 60
    identity = prepare_private_devices()
    callback = SyntheticCallback()
    sources = []
    runtime = TrustedMediaRuntime(callback_client=callback, room_control=NoRooms(),
        api_key="synthetic-key", api_secret="synthetic-in-memory-test-authority-only",
        private_publisher_endpoint="wss://127.0.0.1:7780", viewer_endpoint="wss://127.0.0.1:7781",
        interface="eth0", hdmi=HdmiDeviceConfig(card=1, connector="HDMI-A-1"))
    def source_factory():
        source = SyntheticGdpSource()
        sources.append(source)
        return source
    runtime._supervisor._receiver_factory = source_factory
    report = {"status": "failed", "scope": "synthetic-source production supervisor and actual HDMI",
        "mediaProcessIdentity": identity, "requestedPlaybackSeconds": seconds, "cycles": [],
        "sourceIsSynthetic": True, "platformCallbackIsDouble": True, "appleSenderAccepted": False,
        "receiverAdvertised": False, "browserAccepted": False, "productAccepted": False,
        "physicalObservationProven": False, "recording": False, "cleanupConfirmed": False}
    report["imageSources"] = {str(path.relative_to("/opt/teamaibox")): "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(Path("/opt/teamaibox/services/trusted_media_service").rglob("*.py"))}
    def call(method, session_id=None, body=None):
        path = "/internal/v1/runtime/sessions" + ("/" + session_id if session_id else "")
        return runtime.api.handle(peer_uri_san=PLATFORM_PEER, request_id=str(uuid4()),
            issued_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            method=method, path=path, body=body)
    try:
        for cycle in range(2):
            session_id = str(uuid4())
            expires = time.time() + seconds / 2 + 6
            call("POST", body={"sessionId": session_id, "receiverName": "Team-AI-012ABC6789", "pairingPin": "9876",
                "outputSinks": ["hdmi"], "browserStartsMuted": False, "mediaPrivacyPolicy": dict(PRIVACY_POLICY),
                "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat().replace("+00:00", "Z")})
            active = runtime._supervisor._active
            output, ingress = active.outputs["hdmi"], active.ingress
            deadline, playing, portrait = time.monotonic() + 8, None, False
            while time.monotonic() < deadline:
                state = output.snapshot()
                if state["state"] in ("failed", "closed"): raise RuntimeError("HDMI output failed")
                if state["healthy"] and playing is None:
                    playing = time.monotonic()
                    deadline = playing + seconds / 2
                if cycle == 0 and playing is not None and time.monotonic() - playing >= seconds / 4 and not portrait:
                    sources[-1].portrait()
                    portrait = True
                time.sleep(0.05)
            stats = output.snapshot()
            input_stats = ingress.snapshot()
            assert playing is not None and stats["healthy"]
            assert min(stats["renderedBuffers"].values()) >= 10
            if cycle == 0:
                assert input_stats["tracks"]["video"]["caps"]["width"] == 540
                assert input_stats["tracks"]["video"]["caps"]["height"] == 960
                call("DELETE", session_id, {"sessionId": session_id, "reasonCode": "cast_test_finished"})
            else:
                deadline = time.monotonic() + 8
                while runtime._supervisor._active is not None and time.monotonic() < deadline:
                    runtime.api.expire_session()
                    time.sleep(0.05)
                runtime.api.expire_session()
            assert runtime._supervisor._active is None and runtime.api._active is None
            assert sources[-1].closed and output._device.fd is None
            report["cycles"].append({"cycle": cycle + 1, "output": stats, "ingress": input_stats,
                "portraitObservedInValidatedIngress": portrait, "fdReleased": True, "sourceClosed": True,
                "stopMethod": "DELETE" if cycle == 0 else "TTL"})
        report["streamingCallbacks"] = callback.streamed
        assert callback.streamed == 2
        report["status"] = "passed"
    except Exception as error:
        report["errorClass"] = type(error).__name__
    finally:
        try:
            runtime.close()
            report["cleanupConfirmed"] = runtime._closed and all(source.closed for source in sources)
        except Exception:
            report["status"] = "failed"
        print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "passed" and report["cleanupConfirmed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=20)
    args = parser.parse_args()
    raise SystemExit(run(args.seconds))
