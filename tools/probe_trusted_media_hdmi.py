"""Container-only dedicated test pattern/audio. Never reads user content.

No display-manager mutation, recording, receiver or network. A busy DRM master
is a rejection, not a reason to force ownership. This is not Apple acceptance.
"""
import argparse
from array import array
import json
import os
from pathlib import Path
import stat
import sys
import time
from unittest.mock import patch

from services.trusted_media_service.gdp_media_ingress import _gstreamer
from services.trusted_media_service.hdmi_media_output import KmsDevice, HdmiMediaOutput, HdmiOutputError


def prepare_private_devices():
    """Prepare only runc-created device inodes, then permanently drop root.

    Docker copies the host mode, including GDM's 0600 post-logout mode. Never
    chmod a host bind mount. No root process parses or renders any media.
    """
    if os.getuid() != 0:
        raise ValueError("device preparation requires bootstrap identity")
    paths = ("/dev/dri/card1", "/dev/snd/pcmC0D3p", "/dev/snd/controlC0")
    mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    assert any(row.split()[4] == "/dev" and row.split(" - ", 1)[1].split()[0] == "tmpfs" for row in mounts)
    assert not any(row.split()[4] in paths or row.split()[4] in ("/dev/dri", "/dev/snd") for row in mounts)
    private_dev = os.stat("/dev").st_dev
    nodes = [os.lstat(path) for path in paths]
    assert all(stat.S_ISCHR(node.st_mode) and node.st_dev == private_dev and node.st_uid == 0 for node in nodes)
    assert [(os.major(node.st_rdev), os.minor(node.st_rdev)) for node in nodes] == [(226, 1), (116, 2), (116, 7)]
    for path in paths:
        os.chmod(path, 0o660, follow_symlinks=False)
    os.setgroups(sorted({node.st_gid for node in nodes}))
    os.setgid(65532)
    os.setuid(65532)
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    assert os.getuid() == os.geteuid() == 65532 and os.getgid() == 65532
    assert int(status["CapEff"].strip(), 16) == int(status["CapPrm"].strip(), 16) == 0
    assert status["NoNewPrivs"].strip() == "1"
    return {"privateDeviceInodesOnly": True, "uid": os.getuid(), "gid": os.getgid(),
        "effectiveCapabilities": 0, "permittedCapabilities": 0, "noNewPrivileges": True}


class SyntheticDiagnosticOutput(HdmiMediaOutput):
    """Driver diagnostics only for this generated, network-isolated test.

    Never enable this subclass for an AirPlay session or user media.
    """
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.diagnostic = {"buildEntered": False}

    def start(self):
        import os
        original_open, original_stat, original_fstat = os.open, os.stat, os.fstat
        card_stat = original_stat(self._device.path)
        self.diagnostic["deviceAccess"] = {"uid": os.getuid(), "groups": os.getgroups(),
            "mode": card_stat.st_mode & 0o777, "owner": card_stat.st_uid, "group": card_stat.st_gid,
            "readWriteAllowed": os.access(self._device.path, os.R_OK | os.W_OK)}
        def observe(stage, function):
            def call(*args, **kwargs):
                try:
                    return function(*args, **kwargs)
                except OSError as error:
                    if args[0] == self._device.path:
                        self.diagnostic["deviceError"] = {"stage": stage, "errno": error.errno, "isCard": True}
                    raise
            return call
        with patch.object(os, "open", observe("open", original_open)), \
             patch.object(os, "stat", observe("stat", original_stat)), \
             patch.object(os, "fstat", observe("fstat", original_fstat)):
            return super().start()

    def _build(self):
        self.diagnostic["buildEntered"] = True
        try:
            super()._build()
            self.diagnostic['videoSinkCaps'] = self._sinks['video'].get_static_pad('sink').query_caps(None).to_string()
            self.diagnostic['audioSinkCaps'] = self._sinks['audio'].get_static_pad('sink').query_caps(None).to_string()
        except Exception as error:
            self.diagnostic["exceptionType"] = type(error).__name__
            # Fixed synthetic graph: no sender, user content, URL or credential.
            self.diagnostic["syntheticException"] = str(error)[:240]
            if self._pipeline is not None:
                message = self._pipeline.get_bus().pop_filtered(self._Gst.MessageType.ERROR)
                if message is not None:
                    detail, _ = message.parse_error()
                    factory = message.src.get_factory() if hasattr(message.src, "get_factory") else None
                    self.diagnostic["driverError"] = {"domain": detail.domain, "code": detail.code,
                        "factory": factory.get_name() if factory else None,
                        "syntheticMessage": detail.message[:240]}
            raise

    def _handle_bus_message(self, message):
        # This subclass handles generated patterns only, never live casting.
        # Capture asynchronous sink failures before the production adapter
        # intentionally reduces them to a fixed, content-free reason code.
        if message.type == self._Gst.MessageType.ERROR:
                detail, debug = message.parse_error()
                factory = message.src.get_factory() if hasattr(message.src, 'get_factory') else None
                self.diagnostic['driverError'] = {
                    'domain': detail.domain, 'code': detail.code,
                    'factory': factory.get_name() if factory else None,
                    'syntheticMessage': detail.message[:240],
                    'syntheticDebug': (debug or '')[:480],
                }
        return super()._handle_bus_message(message)


def run(card, connector, audio_card, audio_device, seconds, expect_busy):
    if type(seconds) is not int or not 5 <= seconds <= 60:
        raise ValueError("test duration must be 5 through 60 seconds")
    bootstrap = prepare_private_devices()
    device = KmsDevice(card=card, connector=connector, audio_card=audio_card, audio_device=audio_device)
    output = SyntheticDiagnosticOutput(session_id="10000000-0000-4000-8000-000000000001",
                            expires_at=time.time() + seconds + 45, device=device)
    pipeline = Gst = None
    report = {"status": "failed", "scope": "dedicated synthetic HDMI component",
              "appleSenderAccepted": False, "browserAccepted": False, "productAccepted": False,
              "physicalObservationProven": False, "recording": False, "cleanupConfirmed": False,
              "mediaProcessIdentity": bootstrap, "requestedPlaybackSeconds": seconds,
              "testTone": {"frequencyHz": 440, "initialAmplitude": 0.01,
                           "maximumAmplitude": 0.1, "rampSeconds": 5, "systemVolumeChanged": False}}
    audio_peak = 0
    try:
        output.start()
        if expect_busy:
            raise ValueError("display unexpectedly acquired")
        Gst = _gstreamer()
        # Moving ball and a bounded generated tone with gradual onset; no user media.
        pipeline = Gst.parse_launch("videotestsrc is-live=true pattern=ball ! "
            "video/x-raw,format=I420,width=1920,height=1080,framerate=30/1 ! "
            "appsink name=video sync=false max-buffers=2 drop=true enable-last-sample=false "
            "audiotestsrc name=tone is-live=true volume=0.01 freq=440 ! "
            "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
            "appsink name=audio sync=false max-buffers=2 drop=true enable-last-sample=false")
        sinks = {name: pipeline.get_by_name(name) for name in ("video", "audio")}
        tone = pipeline.get_by_name("tone")
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise ValueError("source unavailable")
        playback_started = None
        deadline = time.monotonic() + 10  # Bounded first-frame/first-audio wait.
        while time.monotonic() < deadline:
            for name, sink in sinks.items():
                sample = sink.try_pull_sample(10 * Gst.MSECOND)
                if sample is not None:
                    if name == "audio":
                        # Synthetic tone only. Keep one aggregate peak, never PCM bytes.
                        buffer = sample.get_buffer()
                        samples = array("h", buffer.extract_dup(0, buffer.get_size()))
                        audio_peak = max(audio_peak, max((abs(value) for value in samples), default=0))
                        del samples
                    output.push(name, sample)
                sample = None
            output_state = output.snapshot()
            if output_state["state"] == "failed":
                raise HdmiOutputError()
            if playback_started is None and output_state["healthy"]:
                playback_started = time.monotonic()
                deadline = playback_started + seconds
            if playback_started is not None:
                amplitude = 0.01 + 0.09 * min(1.0, (time.monotonic() - playback_started) / 5)
                tone.set_property("volume", amplitude)
        report["observedPlaybackSeconds"] = round(time.monotonic() - playback_started, 3) if playback_started else 0
        report["testTone"]["finalAmplitude"] = round(tone.get_property("volume"), 4)
        report["syntheticAudioPeak"] = audio_peak
        report["output"] = output.snapshot()
        report["connectorEnabled"] = device.connector.joinpath("enabled").read_text().strip()
        # Docker intentionally masks /proc/asound. The host runner independently
        # checks the exact PCM while this bounded synthetic test is playing.
        report["audioSinkPlaying"] = output._sinks["audio"].get_state(0)[1] == Gst.State.PLAYING
        if (report["output"]["healthy"] and min(report["output"]["renderedBuffers"].values()) >= 10
                and report["connectorEnabled"] == "enabled" and report["audioSinkPlaying"]
                and report["observedPlaybackSeconds"] >= seconds):
            report["status"] = "passed"
    except HdmiOutputError as error:
        report["reason"] = error.code
        if expect_busy and error.code == "cast_hdmi_display_busy":
            report["status"], report["busyDenied"] = "passed", True
    except Exception as error:
        report["errorClass"] = type(error).__name__
    finally:
        report["syntheticDiagnostic"] = output.diagnostic
        try:
            if pipeline is not None:
                pipeline.set_state(Gst.State.NULL)
                if pipeline.get_state(Gst.SECOND)[1] != Gst.State.NULL:
                    raise ValueError()
            output.close()
            report["cleanupConfirmed"] = device.fd is None
        except Exception:
            report["status"] = "failed"
        print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "passed" and report["cleanupConfirmed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--card", type=int, required=True)
    parser.add_argument("--connector", required=True)
    parser.add_argument("--audio-card", type=int, default=0)
    parser.add_argument("--audio-device", type=int, default=3)
    parser.add_argument("--seconds", type=int, choices=range(5, 61), default=10)
    parser.add_argument("--expect-busy", action="store_true")
    args = parser.parse_args()
    sys.exit(run(args.card, args.connector, args.audio_card, args.audio_device, args.seconds, args.expect_busy))
