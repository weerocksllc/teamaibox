"""Bounded in-memory GDP input for separately admitted media outputs.

Consumes only anonymous read FDs from NativeReceiverProcess. It creates no
receiver, advertisement, encoder, device sink, network endpoint or recording.
The caller must have authorized the source before passing these descriptors.
Samples are pulled by trusted output code and must not enter logs/evidence.
"""
from __future__ import annotations

import fcntl
import os
import re
import stat
from threading import RLock
import time


class MediaIngressError(RuntimeError):
    CODES = frozenset(("media_input", "media_bus", "sample_shape", "video_bounds", "video_format",
                       "video_rate", "audio_bounds", "timestamp", "media_closed"))

    def __init__(self, code="media_input"):
        self.failure_code = code if code in self.CODES else "media_input"
        super().__init__("cast_media_input_unavailable")


def _gstreamer():
    # Runtime dependency is container-only; importing the public module never
    # installs or loads a host GStreamer library.
    import gi
    gi.require_version("Gst", "1.0")
    gi.require_version("GstApp", "1.0")
    from gi.repository import Gst, GstApp  # noqa: F401
    Gst.init(None)
    return Gst


class GdpMediaIngress:
    """Independent non-recording GDP pipelines with bounded per-track queues.

    Video keeps only two frames. Audio keeps up to 32 short PCM buffers so a
    normal network/decode burst is not discarded as though it were video.

    Input descriptors remain caller-owned; this object owns only duplicates.
    ``pull`` returns a Gst.Sample (no byte copies), or None before a frame.
    Neither process liveness nor clean EOS counts as a received frame.
    """
    def __init__(self, *, video_fd: int, audio_fd: int):
        self._Gst = _gstreamer()
        self._lock = RLock()
        self._closed = False
        self._tracks = {}
        try:
            if video_fd == audio_fd:
                raise MediaIngressError()
            for media, fd in (("video", video_fd), ("audio", audio_fd)):
                if (type(fd) is not int or fd < 0 or not stat.S_ISFIFO(os.fstat(fd).st_mode)
                        or fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY
                        or not re.fullmatch(r"pipe:\[[0-9]+\]", os.readlink(f"/proc/self/fd/{fd}"))):
                    raise MediaIngressError()
                duplicate = os.dup(fd)
                track = {"fd": duplicate, "pipeline": None, "sink": None, "state": "waiting",
                         "frames": 0, "observed": 0, "timestampDiscarded": 0,
                         "lastPts": None, "lastAt": None, "caps": None}
                self._tracks[media] = track
                self._build(media, track)
        except Exception:
            self.close()
            raise MediaIngressError() from None

    def _build(self, media, track):
        Gst = self._Gst
        pipeline = Gst.Pipeline.new(None)
        if pipeline is None:
            raise MediaIngressError()
        track["pipeline"] = pipeline
        elements = [Gst.ElementFactory.make(factory, None)
                    for factory in ("fdsrc", "gdpdepay", "capsfilter", "appsink")]
        if any(element is None for element in elements):
            raise MediaIngressError()
        source, _, capsfilter, sink = elements
        source.set_property("fd", track["fd"])
        source.set_property("blocksize", 65536)
        # Restrict media type before handing buffers to any output. Exact
        # geometry/format/timestamp bounds are checked on every pulled sample.
        capsfilter.set_property("caps", Gst.Caps.from_string(media + "/x-raw"))
        sink.set_property("sync", False)
        sink.set_property("max-buffers", 32 if media == "audio" else 2)
        # Older container appsink versions expose only the buffer bound.
        # Newer ones additionally enforce duration/byte limits. Never invent
        # a supported property, or allow an unbounded fallback queue.
        if media == "audio":
            for name, value in (("max-time", 160 * Gst.MSECOND), ("max-bytes", 61440)):
                if sink.find_property(name):
                    sink.set_property(name, value)
        sink.set_property("drop", True)
        sink.set_property("wait-on-eos", False)
        sink.set_property("enable-last-sample", False)
        sink.set_property("emit-signals", False)
        for element in elements:
            pipeline.add(element)
        for before, after in zip(elements, elements[1:]):
            if not before.link(after):
                raise MediaIngressError()
        track["sink"] = sink
        def observed(_pad, info):
            if info.get_buffer() is not None:
                track["observed"] += 1  # Count only; never retain a payload.
            return Gst.PadProbeReturn.OK
        sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, observed)
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise MediaIngressError()

    def _validated_sample(self, media, sample, track):
        Gst = self._Gst
        caps, buffer = sample.get_caps(), sample.get_buffer()
        if caps is None or caps.get_size() != 1 or not caps.is_fixed() or buffer is None:
            raise MediaIngressError("sample_shape")
        structure = caps.get_structure(0)
        if structure.get_name() != media + "/x-raw":
            raise MediaIngressError("sample_shape")
        get = structure.get_value
        size = buffer.get_size()
        if media == "video":
            width, height, format_name = get("width"), get("height"), get("format")
            fraction_ok, numerator, denominator = structure.get_fraction("framerate")
            if (type(width) is not int or type(height) is not int
                    or min(width, height) < 16 or max(width, height) > 1920 or width * height > 1920 * 1080
                    or not 0 < size <= 1920 * 1080 * 4):
                raise MediaIngressError("video_bounds")
            if format_name not in ("I420", "NV12", "RGBA", "BGRA"):
                raise MediaIngressError("video_format")
            if not fraction_ok or denominator <= 0 or not 0 < numerator <= 30 * denominator:
                raise MediaIngressError("video_rate")
            projection = {"width": width, "height": height, "format": format_name,
                          "frameRateNumerator": numerator, "frameRateDenominator": denominator}
            par_ok, par_n, par_d = structure.get_fraction("pixel-aspect-ratio")
            if par_ok and 0 < par_n <= 65535 and 0 < par_d <= 65535:
                projection.update(pixelAspectNumerator=par_n, pixelAspectDenominator=par_d)
            elif not structure.has_field("pixel-aspect-ratio"):
                projection.update(pixelAspectNumerator=1, pixelAspectDenominator=1)
        else:
            rate, channels, format_name = get("rate"), get("channels"), get("format")
            if (rate not in (44100, 48000) or channels not in (1, 2)
                    or format_name not in ("S16LE", "S32LE", "F32LE")
                    or get("layout") != "interleaved" or not 0 < size <= 48000 * 2 * 4):
                raise MediaIngressError("audio_bounds")
            projection = {"rate": rate, "channels": channels, "format": format_name}
        pts = buffer.pts
        segment = sample.get_segment()
        if pts == Gst.CLOCK_TIME_NONE or pts < 0:
            track["timestampDiscarded"] += 1
            return None  # An unpresentable frame is not a failed receiver.
        if segment is not None:
            if segment.format != Gst.Format.TIME:
                track["timestampDiscarded"] += 1
                return None
            pts = segment.to_running_time(Gst.Format.TIME, pts)
        if pts == Gst.CLOCK_TIME_NONE:
            track["timestampDiscarded"] += 1
            return None  # Clip/drop outside a valid segment; never forward it.
        now = time.monotonic()
        previous = track["lastPts"]
        discontinuity = buffer.has_flags(Gst.BufferFlags.DISCONT)
        if previous is not None and not discontinuity:
            if pts <= previous:
                if previous - pts <= 250 * Gst.MSECOND:
                    track["timestampDiscarded"] += 1
                    return None  # Duplicate/late frame, no queue or payload retention.
                # A decoder restart may lose its first DISCONT buffer in the
                # deliberately bounded leaky queue. A backwards clock step
                # beyond the live reordering window starts a new track epoch.
                discontinuity = True
            elif track["lastAt"] is not None and pts - previous > \
                    (now - track["lastAt"]) * Gst.SECOND + 2 * Gst.SECOND:
                discontinuity = True  # Forward source-clock step, not future playout.
        # Outputs consume running-time, not raw timestamps from a prior
        # segment. Share payload memory; copy only the bounded buffer metadata.
        copied = buffer.copy()
        copied.pts, copied.dts = pts, Gst.CLOCK_TIME_NONE
        if discontinuity:
            copied.set_flags(Gst.BufferFlags.DISCONT)
        running_segment = Gst.Segment.new()
        running_segment.init(Gst.Format.TIME)
        sample = Gst.Sample.new(copied, caps, running_segment, None)
        track.update(state="receiving", frames=track["frames"] + 1, lastPts=pts,
                     lastAt=now, caps=projection)
        return sample

    def pull(self, media: str, *, timeout_ms: int = 0):
        if media not in ("video", "audio") or type(timeout_ms) is not int or not 0 <= timeout_ms <= 100:
            raise ValueError("cast_media_poll_invalid")
        with self._lock:
            if self._closed or self._tracks[media]["state"] == "failed":
                raise MediaIngressError("media_closed")
            track = self._tracks[media]
            Gst = self._Gst
            try:
                # Never parse/log GStreamer error strings, source data or URLs.
                if track["pipeline"].get_bus().pop_filtered(Gst.MessageType.ERROR) is not None:
                    raise MediaIngressError("media_bus")
                sample = track["sink"].try_pull_sample(timeout_ms * Gst.MSECOND)
                if sample is not None:
                    return self._validated_sample(media, sample, track)
                if track["sink"].is_eos():
                    track["state"] = "ended"
                return None
            except Exception as error:
                track["state"] = "failed"
                track["pipeline"].set_state(Gst.State.NULL)
                raise MediaIngressError(error.failure_code if isinstance(error, MediaIngressError) else "media_input") from None

    def discard_pending(self) -> dict[str, int]:
        """Drop only the bounded pre-reconnect queues, never future samples."""
        discarded = {"video": 0, "audio": 0}
        with self._lock:
            if self._closed:
                return discarded
            for media, maximum in (("video", 2), ("audio", 32)):
                track = self._tracks[media]
                for _ in range(maximum):
                    if track["sink"].try_pull_sample(0) is None:
                        break
                    discarded[media] += 1
        return discarded

    def snapshot(self):
        with self._lock:
            now = time.monotonic()
            return {"closed": self._closed, "outputsValidated": False,
                    "maximumQueuedSamplesPerTrack": 32,
                    "maximumQueuedSamples": {"video": 2, "audio": 32},
                    "tracks": {media: {"state": track["state"], "receivedFrames": track["frames"],
                        "observedFrames": track["observed"], "timestampDiscarded": track["timestampDiscarded"],
                        "recentInput": not self._closed and track["state"] == "receiving"
                            and track["lastAt"] is not None and now - track["lastAt"] <= 2,
                        "caps": dict(track["caps"]) if track["caps"] is not None else None}
                        for media, track in self._tracks.items()}}

    def close(self):
        with self._lock:
            self._closed = True
            for track in self._tracks.values():
                if track["pipeline"] is not None:
                    track["pipeline"].set_state(self._Gst.State.NULL)
                    track["pipeline"] = None
                    track["sink"] = None
                if track["fd"] is not None:
                    os.close(track["fd"])
                    track["fd"] = None
                track["state"] = "closed"
                track["caps"] = None
