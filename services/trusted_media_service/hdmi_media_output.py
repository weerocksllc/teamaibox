"""Bounded HDMI output; never takes a display away from another DRM master.

The Node Agent must separately admit the display/audio devices and media
reservation. This adapter cannot stop a desktop, change a driver or open a
Docker socket. The read-only connector view must match the assigned card.
Only raw, ingress-validated samples are accepted; nothing is recorded.
"""
from __future__ import annotations

import ctypes
import math
import os
from pathlib import Path
import re
import stat
from threading import RLock
import time

from .gdp_media_ingress import _gstreamer
from .audio_signal_meter import AudioSignalMeter


class HdmiOutputError(RuntimeError):
    def __init__(self, code="cast_hdmi_unavailable"):
        self.code = code
        super().__init__(code)


class KmsDevice:
    """Exact device, connector and PCM; no automatic device/desktop fallback."""
    def __init__(self, *, card, connector, audio_card=0, audio_device=3):
        if (type(card) is not int or not 0 <= card <= 63
                or not isinstance(connector, str) or not re.fullmatch(r"HDMI-A-[1-9][0-9]?", connector)
                or type(audio_card) is not int or not 0 <= audio_card <= 31
                or type(audio_device) is not int or audio_device not in (3, 7, 8, 9)):
            raise ValueError("cast_hdmi_device_invalid")
        self.path = f"/dev/dri/card{card}"
        self.connector = Path(f"/sys/class/drm/card{card}-{connector}")
        self.audio_path = f"/dev/snd/pcmC{audio_card}D{audio_device}p"
        self.alsa = f"hw:{audio_card},{audio_device}"
        self._minor, self.fd, self.connector_id = card, None, None

    def connected(self):
        try:
            return (self.connector.joinpath("status").read_text().strip() == "connected"
                    and "1920x1080" in self.connector.joinpath("modes").read_text().splitlines())
        except (OSError, ValueError):
            return False

    def acquire(self, *, refresh_connector=False):
        if self.fd is not None:
            raise HdmiOutputError()
        if not refresh_connector and not self.connected():
            raise HdmiOutputError("cast_hdmi_disconnected_or_unsupported")
        try:
            value = self.connector.joinpath("connector_id").read_text().strip()
            if not re.fullmatch(r"[1-9][0-9]{0,8}", value):
                raise HdmiOutputError()
            audio = os.stat(self.audio_path, follow_symlinks=False)
            if not stat.S_ISCHR(audio.st_mode) or os.major(audio.st_rdev) != 116:
                raise HdmiOutputError("cast_hdmi_audio_unavailable")
            fd = os.open(self.path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            self.fd = fd  # Retain the exact owned FD until every failure closes it.
            info = os.fstat(fd)
            if (not stat.S_ISCHR(info.st_mode) or os.major(info.st_rdev) != 226
                    or os.minor(info.st_rdev) != self._minor):
                raise HdmiOutputError()
            drm = ctypes.CDLL("libdrm.so.2")
            drm.drmIsMaster.argtypes, drm.drmIsMaster.restype = [ctypes.c_int], ctypes.c_int
            if drm.drmIsMaster(fd) != 1:
                raise HdmiOutputError("cast_hdmi_display_busy")
            # Deliberately no drmSetMaster, logind takeover, VT switch or shell.
            self.connector_id = int(value)
            if refresh_connector:
                # Only once at an explicitly started, already-owned KMS session.
                # GETCONNECTOR refreshes cached status/modes/EDID. Reading sysfs
                # alone before this can falsely reject a display used by Xorg.
                drm.drmModeGetConnector.argtypes = [ctypes.c_int, ctypes.c_uint32]
                drm.drmModeGetConnector.restype = ctypes.c_void_p
                drm.drmModeFreeConnector.argtypes = [ctypes.c_void_p]
                drm.drmModeFreeConnector.restype = None
                pointer = drm.drmModeGetConnector(fd, self.connector_id)
                try:
                    if not pointer or not self.connected():
                        raise HdmiOutputError("cast_hdmi_disconnected_or_unsupported")
                finally:
                    if pointer:
                        drm.drmModeFreeConnector(pointer)
        except Exception as error:
            self.release()
            if isinstance(error, HdmiOutputError):
                raise
            raise HdmiOutputError() from None

    def release(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.connector_id = None


class HdmiMediaOutput:
    """Independent KMS/BGRA + ALSA/S16 output at 1080p30, bounded queues.

    Appsrc accepts a shared-clock timestamp projection for both tracks.
    Landscape and portrait inputs are letterboxed, not stretched. A display
    disconnect or sink error fails only this adapter; the supervisor owns
    continued browser output and explicit restart after output recovery.
    """
    def __init__(self, *, session_id, expires_at, device: KmsDevice):
        if (not isinstance(session_id, str)
                or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", session_id)
                or type(expires_at) not in (int, float) or not math.isfinite(expires_at)
                or not time.time() < expires_at <= time.time() + 14400
                or not isinstance(device, KmsDevice)):
            raise ValueError("cast_hdmi_configuration_invalid")
        self._device, self._expiry = device, expires_at
        if callable(getattr(device, 'bind_lease', None)):
            device.bind_lease(session_id, expires_at)
        self._lock, self._Gst = RLock(), None
        self._pipeline, self._sources, self._sinks = None, {}, {}
        self._started = self._closed = False
        self._error, self._shift = None, None
        self._track_shift = {"video": None, "audio": None}
        self._timeline_resets = {"video": 0, "audio": 0}
        self._skew_ms = {"video": 0, "audio": 0}
        self._initial_correction_ms = {"video": 0, "audio": 0}
        self._audio_overruns = 0
        self._latency_dirty, self._latency_caps = True, None
        self._latency_retry_at, self._latency_updates = 0, 0
        self._signal_meter = AudioSignalMeter()
        self._last = {"video": None, "audio": None}
        self._pushed = {"video": 0, "audio": 0}

    def start(self):
        with self._lock:
            if self._started or self._closed:
                raise HdmiOutputError()
            self._started = True
            try:
                self._device.acquire()
                self._Gst = _gstreamer()
                self._build()
            except Exception as error:
                self._error = error.code if isinstance(error, HdmiOutputError) else "cast_hdmi_unavailable"
                # Keep the handle owned if teardown itself fails.
                self.close()
                raise HdmiOutputError(self._error) from None

    def _build(self):
        Gst = self._Gst
        self._pipeline = Gst.Pipeline.new(None)
        if self._pipeline is None:
            raise HdmiOutputError()
        for media, factories in (("video", ("appsrc", "videoconvert", "videoscale", "capsfilter", "kmssink")),
                                 ("audio", ("appsrc", "audioconvert", "audioresample", "capsfilter", "alsasink"))):
            elements = [Gst.ElementFactory.make(name, None) for name in factories]
            if any(element is None for element in elements):
                raise HdmiOutputError("cast_hdmi_runtime_missing")
            source, sink = elements[0], elements[-1]
            # A video frame can replace an older frame, but each audio block
            # carries a successive piece of sound. Video must also hold the
            # negotiated audio lead (about 110 ms): two frames discard healthy
            # 30 fps input while KMS waits for sync. Bound it to 8 frames/250 ms
            # and 64 MiB of raw pixels; keep downstream leaking under overload.
            for key, value in (("is-live", True), ("format", Gst.Format.TIME), ("block", False),
                               ("max-buffers", 32 if media == "audio" else 8),
                               ("max-bytes", 61440 if media == "audio" else 1920 * 1080 * 4 * 8),
                               ("max-time", (160 if media == "audio" else 250) * Gst.MSECOND),
                               ("leaky-type", 2), ("emit-signals", False)):
                source.set_property(key, value)
            for key, value in (("enable-last-sample", False), ("sync", True), ("async", False)):
                sink.set_property(key, value)
            if media == "video":
                elements[2].set_property("add-borders", True)
                # KMS advertises the connected display's pixel aspect ratio.
                # Let videoscale negotiate it and preserve content aspect with
                # borders; hard-coding 1/1 rejects valid 1080p displays (15/16).
                elements[3].set_property("caps", Gst.Caps.from_string(
                    "video/x-raw,format=BGRA,width=1920,height=1080"))
                for key, value in (("fd", self._device.fd), ("connector-id", self._device.connector_id),
                                   ("force-modesetting", True), ("restore-crtc", True), ("can-scale", False)):
                    sink.set_property(key, value)
            else:
                elements[3].set_property("caps", Gst.Caps.from_string(
                    "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2"))
                sink.set_property("device", self._device.alsa)
                sink.set_property("buffer-time", 100000)
                sink.set_property("latency-time", 10000)
                # Observe only a signal-present count at the actual ALSA input,
                # after conversion/resampling; no samples are stored or logged.
                sink.get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, self._measure_audio)
            for element in elements:
                self._pipeline.add(element)
            for before, after in zip(elements, elements[1:]):
                if not before.link(after):
                    raise HdmiOutputError()
            self._sources[media], self._sinks[media] = source, sink
        if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise HdmiOutputError()
        result, _, _ = self._pipeline.get_state(Gst.SECOND)
        if result == Gst.StateChangeReturn.FAILURE:
            raise HdmiOutputError()
        self._check()

    def _measure_audio(self, _pad, info):
        buffer = info.get_buffer()
        if buffer is not None:
            if buffer.get_size() <= 48000 * 2 * 2:
                self._signal_meter.observe_s16le(buffer.extract_dup(0, buffer.get_size()))
            else:
                self._signal_meter.observe_s16le(b'')
        return self._Gst.PadProbeReturn.OK

    def _check(self):
        if self._closed or self._error or self._pipeline is None:
            raise HdmiOutputError(self._error or "cast_hdmi_unavailable")
        if time.time() >= self._expiry:
            self._error = "cast_hdmi_session_expired"
        elif not self._device.connected():
            self._error = "cast_hdmi_disconnected_or_unsupported"
        if self._error:
            raise HdmiOutputError(self._error)
        # pop_filtered(ERROR) also removes LATENCY messages. Appsrc has no caps
        # at PLAYING startup, so that loses the later ALSA ring-buffer latency
        # negotiation and can make the device play silence despite rendering.
        kinds = self._Gst.MessageType.ERROR | self._Gst.MessageType.LATENCY
        for _ in range(32):
            message = self._pipeline.get_bus().pop_filtered(kinds)
            if message is None:
                break
            self._handle_bus_message(message)
            if self._error:
                raise HdmiOutputError(self._error)
        self._refresh_latency()

    def _handle_bus_message(self, message):
        if message.type == self._Gst.MessageType.ERROR:
            self._error = "cast_hdmi_output_failed"  # No driver/media diagnostic strings.
        elif message.type == self._Gst.MessageType.LATENCY:
            self._latency_dirty = True

    def _refresh_latency(self):
        caps = tuple(self._sinks[media].get_static_pad('sink').get_current_caps()
                     if media in self._sinks else None for media in ('audio', 'video'))
        # A device can report zero latency before its audio format is known.
        # Retry after negotiation, including format changes and reconnections.
        if caps[0] is None or not caps[0].is_fixed():
            return
        fingerprint = tuple(value.to_string() if value is not None else None for value in caps)
        if not self._latency_dirty and fingerprint == self._latency_caps:
            return
        now = time.monotonic()
        if now < self._latency_retry_at:
            return
        self._latency_retry_at = now + .1
        # GStreamer queries the real sinks and applies one negotiated latency
        # to both tracks; do not disable sync or invent an audio-only offset.
        if self._pipeline.recalculate_latency():
            self._latency_caps, self._latency_dirty = fingerprint, False
            self._latency_updates += 1

    def push(self, media, sample):
        with self._lock:
            self._check()
            Gst = self._Gst
            try:
                if media not in self._sources or not isinstance(sample, Gst.Sample):
                    raise HdmiOutputError()
                caps, incoming = sample.get_caps(), sample.get_buffer()
                if (caps is None or caps.get_size() != 1 or not caps.is_fixed() or incoming is None
                        or caps.get_structure(0).get_name() != media + "/x-raw"
                        or incoming.pts == Gst.CLOCK_TIME_NONE or not 0 < incoming.get_size() <= 1920 * 1080 * 4):
                    raise HdmiOutputError()
                structure = caps.get_structure(0)
                get = structure.get_value
                if media == "video":
                    width, height = get("width"), get("height")
                    ok, num, den = structure.get_fraction("framerate")
                    if (type(width) is not int or type(height) is not int or min(width, height) < 16
                            or max(width, height) > 1920 or width * height > 1920 * 1080
                            or get("format") not in ("I420", "NV12", "RGBA", "BGRA")
                            or not ok or den <= 0 or not 0 < num <= 30 * den):
                        raise HdmiOutputError()
                elif (get("format") not in ("S16LE", "S32LE", "F32LE") or get("rate") not in (44100, 48000)
                      or get("channels") not in (1, 2) or get("layout") != "interleaved"
                      or incoming.get_size() > 48000 * 2 * 4):
                    raise HdmiOutputError()
                segment = sample.get_segment()
                pts = segment.to_running_time(Gst.Format.TIME, incoming.pts) if segment is not None else incoming.pts
                if pts == Gst.CLOCK_TIME_NONE:
                    raise HdmiOutputError()
                discontinuity = incoming.has_flags(Gst.BufferFlags.DISCONT)
                if self._last[media] is not None and pts <= self._last[media] and not discontinuity:
                    raise HdmiOutputError()
                clock = self._pipeline.get_clock()
                if clock is None:
                    raise HdmiOutputError()
                now = max(0, clock.get_time() - self._pipeline.get_base_time())
                if self._shift is None:
                    self._shift = now - pts
                if self._track_shift[media] is None:
                    candidate = pts + self._shift
                    # The native AAC/ALAC and video decoders can start on
                    # independent timelines. Preserve ordinary A/V offsets;
                    # otherwise anchor the new track at its actual arrival.
                    independent = abs(candidate - now) > 200 * Gst.MSECOND
                    self._track_shift[media] = now - pts if independent else self._shift
                    self._initial_correction_ms[media] = (now - candidate) // Gst.MSECOND if independent else 0
                elif self._last[media] is not None and discontinuity:
                    # Both forward and backward clock resets affect only this
                    # track, never move the other track or reuse stale time.
                    self._track_shift[media] = now - pts
                    self._timeline_resets[media] += 1
                self._last[media] = pts
                copied = incoming.copy()  # Metadata only; the raw memory remains ref-counted.
                copied.pts, copied.dts = max(0, pts + self._track_shift[media]), Gst.CLOCK_TIME_NONE
                self._skew_ms[media] = (copied.pts - now) // Gst.MSECOND
                if media == "audio":
                    source = self._sources[media]
                    if (source.get_property("current-level-buffers") >= 32
                            or source.get_property("current-level-bytes") >= 61440
                            or source.get_property("current-level-time") >= 160 * Gst.MSECOND):
                        self._audio_overruns += 1
                self._sources[media].set_property("caps", caps)
                if self._sources[media].emit("push-buffer", copied) != Gst.FlowReturn.OK:
                    raise HdmiOutputError()
                self._pushed[media] += 1
            except Exception:
                self._error = "cast_hdmi_input_invalid"
                raise HdmiOutputError(self._error) from None

    def snapshot(self):
        with self._lock:
            try:
                self._check()
                rendered = {name: int(sink.get_property("stats").get_value("rendered") or 0)
                            for name, sink in self._sinks.items()}
                dropped = {name: int(sink.get_property("stats").get_value("dropped") or 0)
                           for name, sink in self._sinks.items()}
                return {"healthy": all(rendered.values()), "state": "rendering" if all(rendered.values()) else "waiting",
                        "renderedBuffers": rendered, "pushedSamples": dict(self._pushed),
                        "droppedBuffers": dropped, "timelineResets": dict(self._timeline_resets),
                        "scheduleSkewMs": dict(self._skew_ms), "initialCorrectionMs": dict(self._initial_correction_ms),
                        "audioQueueOverruns": self._audio_overruns,
                        "latencyUpdates": self._latency_updates,
                        "audioSignal": self._signal_meter.snapshot(),
                        "maximumQueuedSamplesPerTrack": 32,
                        "maximumQueuedSamples": {"video": 8, "audio": 32},
                        "queuedSamples": {name: source.get_property("current-level-buffers")
                                          for name, source in self._sources.items()},
                        "physicalObservationProven": False}
            except HdmiOutputError as error:
                return {"healthy": False, "state": "closed" if self._closed else "failed", "reason": error.code}

    def close(self):
        with self._lock:
            if self._pipeline is not None:
                Gst = self._Gst
                result = self._pipeline.set_state(Gst.State.NULL)
                _, state, _ = self._pipeline.get_state(3 * Gst.SECOND)
                if result == Gst.StateChangeReturn.FAILURE or state != Gst.State.NULL:
                    raise HdmiOutputError("cast_hdmi_cleanup_pending")
            self._pipeline = None
            self._sources.clear()
            self._sinks.clear()
            self._device.release()
            self._closed = True
