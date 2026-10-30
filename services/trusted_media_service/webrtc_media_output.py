"""One non-recording, bounded publisher fed by the private GDP ingress.

This is an output adapter, not a viewer authorization boundary. Its WSS
endpoint must be the admitted private SFU ingress, never the public Web API.
Only decoded Gst.Sample objects cross this boundary; package-owned elements
and RAM-only signaller properties replace shell pipelines containing secrets.
An encoded frame is not evidence that a browser has received that frame.
"""
from __future__ import annotations

from threading import RLock
import time

from .gdp_media_ingress import _gstreamer
from .publisher_credentials import PublisherCredential


OUTPUT_FAILURE_CODES = frozenset((
    "browser_credential", "browser_pipeline_build", "browser_pipeline_bus",
    "browser_sample", "browser_clock", "browser_push",
    "browser_encoder_topology", "browser_cleanup", "browser_output",
    "browser_sfu", "browser_webrtc", "browser_encoder",
    "browser_audio_pipeline", "browser_video_pipeline", "browser_stream",
))


class MediaOutputError(RuntimeError):
    def __init__(self, code="browser_output"):
        self.failure_code = code if code in OUTPUT_FAILURE_CODES else "browser_output"
        super().__init__("cast_browser_output_unavailable")


class WebRtcMediaOutput:
    """Exactly one LiveKit publisher, VP8/Opus, no STUN/public-network fallback.

    Video appsrc holds two buffers; audio has a 32-buffer/160 ms/60 KiB
    bound to absorb short bursts. Overflow drops old buffers without blocking.
    The SFU fans out the encoded stream; a viewer never constructs
    another pipeline. Codec-discovery encoders are counted separately from
    the encoder belonging to the live SFU connection.
    """
    def __init__(self, *, credential: PublisherCredential):
        if not isinstance(credential, PublisherCredential) or credential.expires_at <= time.time():
            raise MediaOutputError("browser_credential")
        self._Gst = _gstreamer()
        self._lock = RLock()
        self._pipeline = self._sink = self._signaller = None
        self._sources = {}
        self._encoders = {}
        self._audio_encoders = {}
        self._failed = False
        self._failure_code = None
        self._closed = False
        self._shift = None
        self._track_shift = {"video": None, "audio": None}
        self._last_silence = None
        self._last_input = {"video": None, "audio": None}
        self._pushed = {"video": 0, "audio": 0}
        try:
            self._build(credential)
        except Exception as error:
            code = getattr(error, "failure_code", "browser_pipeline_build")
            try:
                self.close()
            except Exception:
                pass
            self._failure_code = code if code in OUTPUT_FAILURE_CODES else "browser_pipeline_build"
            raise MediaOutputError(self._failure_code) from None

    def _build(self, credential):
        Gst = self._Gst
        self._pipeline = Gst.Pipeline.new(None)
        self._sink = Gst.ElementFactory.make("livekitwebrtcsink", None)
        if self._pipeline is None or self._sink is None:
            raise MediaOutputError("browser_pipeline_build")
        sink = self._sink
        sink.set_property("video-caps", Gst.Caps.from_string("video/x-vp8"))
        sink.set_property("audio-caps", Gst.Caps.from_string("audio/x-opus"))
        sink.set_property("stun-server", None)
        # The pinned ARM64 plugin has no GCC estimator. This is an explicit,
        # bounded supported policy, not a silent runtime fallback.
        sink.set_property("congestion-control", "homegrown")
        for name, value in (("min-bitrate", 200_000), ("start-bitrate", 2_000_000),
                            ("max-bitrate", 8_000_000)):
            sink.set_property(name, value)
        sink.connect("encoder-setup", self._encoder_setup)
        self._signaller = sink.get_property("signaller")
        for name, value in (("ws-url", credential.endpoint), ("room-name", credential.room),
                            ("auth-token", credential.access_token), ("timeout", 5)):
            self._signaller.set_property(name, value)
        self._pipeline.add(sink)
        for media in ("video", "audio"):
            source = Gst.ElementFactory.make("appsrc", None)
            if source is None:
                raise MediaOutputError("browser_pipeline_build")
            for name, value in (("is-live", True), ("format", Gst.Format.TIME), ("block", False),
                                ("max-buffers", 32 if media == "audio" else 2),
                                ("max-bytes", 61440 if media == "audio" else 0),
                                ("max-time", 160 * Gst.MSECOND if media == "audio" else 0),
                                ("leaky-type", 2), ("emit-signals", False)):
                source.set_property(name, value)
            self._pipeline.add(source)
            tail = source
            if media == "audio":
                # The pinned sink cannot renegotiate audio caps. Normalize
                # both startup silence and actual 44.1/48 kHz AirPlay audio
                # before its pad, rather than relabelling PCM samples.
                for factory in ("audioconvert", "audioresample", "capsfilter"):
                    element = Gst.ElementFactory.make(factory, None)
                    if element is None:
                        raise MediaOutputError("browser_pipeline_build")
                    if factory == "capsfilter":
                        element.set_property("caps", Gst.Caps.from_string(
                            "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2"))
                    self._pipeline.add(element)
                    if not tail.link(element):
                        raise MediaOutputError("browser_pipeline_build")
                    tail = element
            pad = sink.request_pad_simple(media + "_%u")
            if pad is None or tail.get_static_pad("src").link(pad) != Gst.PadLinkReturn.OK:
                raise MediaOutputError("browser_pipeline_build")
            self._sources[media] = source
        if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise MediaOutputError("browser_pipeline_build")

    def _prime_silent_audio(self):
        """Negotiate the fixed audio track while a paired sender is silent.

        The sink waits for codec discovery on every requested track and does
        not allow adding a track after PLAYING. Feed explicit zero/GAP PCM,
        on a continuous 20 ms audio timeline until real audio arrives. Video
        ticks need not arrive every 20 ms: a 30 fps tick may feed two chunks.
        Catch-up is bounded; after a long stall start a new discontinuity
        instead of queuing stale silence. This is
        silence, never counted as received/pushed user audio or audio health.
        Nothing is generated before an authorized video sample is received.
        """
        if self._pushed["audio"]:
            return
        Gst = self._Gst
        now = max(0, self._pipeline.get_clock().get_time() - self._pipeline.get_base_time())
        duration = 20 * Gst.MSECOND
        pts = now if self._last_silence is None else self._last_silence + duration
        discontinuity = now - pts >= 8 * duration
        if discontinuity:
            pts = now
        if pts > now:
            return
        source = self._sources["audio"]
        source.set_property("caps", Gst.Caps.from_string(
            "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2"))
        while pts <= now:
            buffer = Gst.Buffer.new_allocate(None, 960 * 2 * 2, None)
            buffer.memset(0, 0, buffer.get_size())
            buffer.pts, buffer.duration = pts, duration
            buffer.set_flags(Gst.BufferFlags.GAP)
            if discontinuity:
                buffer.set_flags(Gst.BufferFlags.DISCONT)
                discontinuity = False
            if source.emit("push-buffer", buffer) != Gst.FlowReturn.OK:
                raise MediaOutputError("browser_push")
            self._last_silence = pts
            pts += duration

    def _encoder_setup(self, element, consumer_id, pad_name, encoder):
        if consumer_id and pad_name.startswith(("video_", "audio_")):
            # Do not take the API lock from a GStreamer streaming callback.
            # NULL teardown waits for that callback and must not deadlock.
            encoders = self._encoders if pad_name.startswith("video_") else self._audio_encoders
            if len(encoders) >= 16:
                self._failed = True
                self._failure_code = "browser_encoder_topology"
                return False
            row = {"factory": encoder.get_factory().get_name(), "buffers": 0, "lastAt": None}
            encoders[(consumer_id, pad_name)] = row
            def encoded(pad, info):
                if info.get_buffer() is not None:
                    row["buffers"] += 1
                    row["lastAt"] = time.monotonic()
                return self._Gst.PadProbeReturn.OK
            encoder.get_static_pad("src").add_probe(self._Gst.PadProbeType.BUFFER, encoded)
        return False

    def _check(self):
        if self._closed or self._failed or self._pipeline is None:
            raise MediaOutputError(self._failure_code or "browser_output")
        message = self._pipeline.get_bus().pop_filtered(self._Gst.MessageType.ERROR)
        if message is not None:
            self._failed = True
            self._failure_code = self._bus_failure_code(message)
            raise MediaOutputError(self._failure_code)  # Never parse/log a signaller error/token.

    @staticmethod
    def _bus_failure_code(message):
        """Map package-owned GStreamer stages to fixed codes only.

        Error text, debug text, URLs, tokens, source names and media metadata
        are deliberately neither returned nor retained.
        """
        try:
            source = message.src
            factory = source.get_factory() if hasattr(source, "get_factory") else None
            factory_name = factory.get_name() if factory is not None else ""
            source_type = type(source).__name__
            error, _ = message.parse_error()
            domain = str(getattr(error, "domain", ""))
            if (factory_name == "livekitwebrtcsink" or source_type in
                    ("GstLiveKitSignaller", "GstLiveKitWebRTCSink") or "resource" in domain):
                return "browser_sfu"
            if factory_name in ("webrtcbin", "nicesrc", "nicesink"):
                return "browser_webrtc"
            if factory_name in ("vp8enc", "opusenc") or factory_name.endswith("enc"):
                return "browser_encoder"
            if factory_name.startswith("audio"):
                return "browser_audio_pipeline"
            if factory_name.startswith("video"):
                return "browser_video_pipeline"
            if "stream" in domain:
                return "browser_stream"
        except Exception:
            pass
        return "browser_pipeline_bus"

    def push(self, media: str, sample) -> None:
        """Push an ingress-validated sample; no writable copy of its payload.

        Rebase both tracks onto the same output running-time origin. Source
        timestamp differences (A/V sync) survive; independent per-track clock
        resets would incorrectly erase them. Payload memory is ref-counted,
        only buffer metadata is copied. No recording or retained last frame.
        """
        with self._lock:
            self._check()
            Gst = self._Gst
            try:
                if media not in self._sources or not isinstance(sample, Gst.Sample):
                    raise MediaOutputError("browser_sample")
                caps, incoming = sample.get_caps(), sample.get_buffer()
                if (caps is None or caps.get_size() != 1 or not caps.is_fixed() or incoming is None
                        or caps.get_structure(0).get_name() != media + "/x-raw"
                        or incoming.pts == Gst.CLOCK_TIME_NONE or incoming.get_size() > 1920 * 1080 * 4):
                    raise MediaOutputError("browser_sample")
                segment = sample.get_segment()
                pts = segment.to_running_time(Gst.Format.TIME, incoming.pts) if segment is not None else incoming.pts
                if pts == Gst.CLOCK_TIME_NONE:
                    raise MediaOutputError("browser_sample")
                clock = self._pipeline.get_clock()
                if clock is None:
                    raise MediaOutputError("browser_clock")
                now = max(0, clock.get_time() - self._pipeline.get_base_time())
                if self._shift is None:
                    self._shift = now - pts
                if self._track_shift[media] is None:
                    # Separate native decoder pipelines can begin minutes
                    # apart. Reuse the common origin when their clocks agree;
                    # otherwise anchor a newly started track to live time,
                    # not to timestamps from before that track existed.
                    candidate = pts + self._shift
                    self._track_shift[media] = (self._shift if abs(candidate-now) <= 200 * Gst.MSECOND
                                                else now-pts)
                elif self._last_input[media] is not None and incoming.has_flags(Gst.BufferFlags.DISCONT):
                    # A restarted decoder must not move the other track's
                    # clock backwards or replay stale timestamps into RTP.
                    # Forward clock corrections also need a fresh alignment.
                    self._track_shift[media] = now - pts
                self._last_input[media] = pts
                copied = incoming.copy()
                copied.pts = max(0, pts + self._track_shift[media])
                copied.dts = Gst.CLOCK_TIME_NONE
                self._sources[media].set_property("caps", caps)
                if self._sources[media].emit("push-buffer", copied) != Gst.FlowReturn.OK:
                    raise MediaOutputError("browser_push")
                self._pushed[media] += 1
                if media == "video":
                    self._prime_silent_audio()
            except Exception as error:
                self._failed = True
                code = getattr(error, "failure_code", "browser_output")
                self._failure_code = code if code in OUTPUT_FAILURE_CODES else "browser_output"
                raise MediaOutputError(self._failure_code) from None

    def snapshot(self) -> dict:
        """Only counters/health; never a credential, room, URL or media byte."""
        with self._lock:
            try:
                self._check()
                stats = self._sink.get_property("stats")
                count = stats.n_fields()
                rows = [row for (identity, _), row in self._encoders.items()
                        if count == 1 and identity == stats.nth_field_name(0)]
                audio_rows = [row for (identity, _), row in self._audio_encoders.items()
                              if count == 1 and identity == stats.nth_field_name(0)]
                if count > 1 or len(rows) > 1 or any(row["factory"] != "vp8enc" for row in rows):
                    self._failed = True
                    self._failure_code = "browser_encoder_topology"
                    raise MediaOutputError(self._failure_code)
                recent = len(rows) == 1 and rows[0]["lastAt"] is not None \
                    and time.monotonic() - rows[0]["lastAt"] <= 2
                return {"healthy": recent, "state": "publishing" if recent else "waiting",
                        "activeSfuConnections": count, "activeVideoEncoders": len(rows),
                        "encodedVideoBuffers": sum(row["buffers"] for row in rows),
                        "encodedAudioBuffers": sum(row["buffers"] for row in audio_rows),
                        "pushedSamples": dict(self._pushed), "maximumQueuedSamplesPerTrack": 32,
                        "maximumQueuedSamples": {"video": 2, "audio": 32},
                        "queuedSamples": {key: source.get_property("current-level-buffers")
                                          for key, source in self._sources.items()},
                        "browserDeliveryProven": False}
            except MediaOutputError:
                return {"healthy": False, "state": "closed" if self._closed else "failed"}

    def failure_code(self) -> str:
        """Return only a bounded stage code; never backend text or media data."""
        with self._lock:
            return self._failure_code or "browser_output"

    def close(self) -> None:
        with self._lock:
            if self._pipeline is not None:
                Gst = self._Gst
                result = self._pipeline.set_state(Gst.State.NULL)
                _, state, _ = self._pipeline.get_state(3 * Gst.SECOND)
                if result == Gst.StateChangeReturn.FAILURE or state != Gst.State.NULL:
                    self._failed = True
                    self._failure_code = "browser_cleanup"
                    raise MediaOutputError(self._failure_code)  # Retain handle for cleanup retry.
            if self._signaller is not None:
                self._signaller.set_property("auth-token", "")
            self._pipeline = self._sink = self._signaller = None
            self._sources.clear()
            self._encoders.clear()
            self._audio_encoders.clear()
            self._closed = True
