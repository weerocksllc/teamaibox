"""Candidate MPEG-TS/H.264 decoder, not enabled in the product catalog.

The host authorizes a source and passes a pre-bound, exclusive UDP socket.
There are no URLs, file paths, port binding, guest networking or audio capture.
Run in a supervised process inside the existing phone resource budget. The
caller must clear the camera frame on on_end and close the original socket.
"""
import threading
import time

from phone_camera_input import jpeg_frame
from phone_udp_ingress import UdpIngress, UdpIngressError
from phone_video_camera import source_format


class UdpCameraError(RuntimeError):
    pass


def parsed_format(width, height, numerator, denominator):
    # Unlike MP4, a valid live H.264 SPS can omit a nominal frame rate. Keep
    # that fact explicit; do not invent 30 fps. Delivery is paced separately.
    if numerator == 0 and denominator == 1 and type(numerator) is int:
        value = source_format(width, height, 1, 1)
        value['frameRate'] = None
        return value
    return source_format(width, height, numerator, denominator)


class UdpCameraSource:
    def __init__(self, bound_socket, policy, *, deliver, on_end=lambda reason: None):
        if not callable(deliver) or not callable(on_end):
            raise UdpCameraError('phone_camera_udp_configuration_invalid')
        self._deliver, self._on_end = deliver, on_end
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._push_lock = threading.Lock()
        self._closed = False
        self._reason = None
        self._pipeline = self._ingress = self._watch = None
        self._linked = False
        self._format = None
        self._rejected_format = None
        self._sequence = 0
        self._last_pts = None
        self._last_frame = None
        self._first_packet = None
        self._last_delivery = 0
        self._pending_frame = None
        self._queue_drops = self._rate_drops = 0
        self._queue_peak = 0
        try:
            import gi
            gi.require_version('Gst', '1.0')
            from gi.repository import Gst
            Gst.init(None)
            self.Gst = Gst
            self._pipeline = Gst.Pipeline.new(None)
            self._input = Gst.ElementFactory.make('appsrc')
            self._demux = Gst.ElementFactory.make('tsdemux')
            if not self._pipeline or not self._input or not self._demux:
                raise UdpCameraError('phone_camera_udp_runtime_unavailable')
            for k, v in {'is-live': True, 'format': Gst.Format.TIME,
                         'do-timestamp': True, 'block': False,
                         'max-bytes': 262144, 'max-buffers': 0,
                         'emit-signals': False}.items():
                self._input.set_property(k, v)
            self._input.set_property('caps', Gst.Caps.from_string(
                'video/mpegts,systemstream=true,packetsize=188'))
            self._demux.set_property('latency', 100)
            self._pipeline.add(self._input)
            self._pipeline.add(self._demux)
            if not self._input.link(self._demux):
                raise UdpCameraError('phone_camera_udp_runtime_unavailable')
            # The bounded live pipeline follows TS PCR/PTS: a UDP datagram can
            # contain several compressed frames, which must not all be emitted
            # at packet-arrival time. Watchdog cancellation bounds bad/future
            # timestamps; no unbounded decoded-frame queue is introduced.
            self._video = Gst.parse_bin_from_description(
                'h264parse name=parser ! openh264dec ! videoconvert ! '
                'videoscale add-borders=true ! '
                'video/x-raw,width=640,height=480,pixel-aspect-ratio=1/1 ! '
                'jpegenc quality=85 ! appsink name=frame emit-signals=true '
                'max-buffers=1 drop=true sync=true max-lateness=100000000 '
                'processing-deadline=0 qos=true enable-last-sample=false', True)
            self._pipeline.add(self._video)
            self._video.get_by_name('parser').get_static_pad('src').add_probe(
                Gst.PadProbeType.EVENT_DOWNSTREAM, self._format_event)
            self._video.get_by_name('frame').connect('new-sample', self._sample)
            self._demux.connect('pad-added', self._pad_added)
            if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise UdpCameraError('phone_camera_udp_decode_failed')
            self._ingress = UdpIngress(bound_socket, policy, deliver=self._packet,
                                       on_end=self._finish)
            self._watch = threading.Thread(target=self._watch_bus, daemon=True)
            self._watch.start()
        except BaseException:
            self.close()
            raise

    def _finish(self, reason):
        with self._lock:
            if self._closed or self._stopped.is_set():
                return
            self._reason = reason
            self._stopped.set()

    def _packet(self, value, received_at_ns):
        with self._push_lock:
            if self._stopped.is_set():
                return
            if self._first_packet is None:
                self._first_packet = time.monotonic()
            # Bound bytes, not datagram count: an ordinary IDR burst contains
            # many small TS datagrams. Dropping packet 33 corrupts compressed
            # frames even when most of the byte budget is still available.
            # On a real byte-budget overrun stop explicitly; never silently
            # feed a damaged compressed stream and leave a stale camera frame.
            size = self._input.get_property('current-level-bytes')
            if size + len(value) > 262144:
                self._queue_drops += 1
                self._finish('phone_camera_udp_buffer_overrun')
                return
            buffer = self.Gst.Buffer.new_allocate(None, len(value), None)
            buffer.fill(0, value)
            if self._input.emit('push-buffer', buffer) != self.Gst.FlowReturn.OK:
                raise UdpIngressError('phone_camera_udp_decode_failed')
            self._queue_peak = max(self._queue_peak, size + len(value))

    def _pad_added(self, demux, pad):
        caps = pad.get_current_caps()
        if self._stopped.is_set() or caps is None or caps.get_size() != 1:
            self._finish('phone_camera_udp_format_unsupported')
            return
        name = caps.get_structure(0).get_name()
        if name.startswith('audio/'):
            sink = self.Gst.ElementFactory.make('fakesink')
            for k in ('sync', 'async', 'enable-last-sample'):
                sink.set_property(k, False)
            self._pipeline.add(sink)
            sink.sync_state_with_parent()
            if pad.link(sink.get_static_pad('sink')) != self.Gst.PadLinkReturn.OK:
                self._finish('phone_camera_udp_decode_failed')
            return
        if name != 'video/x-h264' or self._linked:
            self._finish('phone_camera_udp_format_unsupported')
            return
        self._linked = True
        if pad.link(self._video.get_static_pad('sink')) != self.Gst.PadLinkReturn.OK:
            self._finish('phone_camera_udp_decode_failed')

    def _format_event(self, pad, info):
        if self._stopped.is_set():
            return self.Gst.PadProbeReturn.DROP
        event = info.get_event()
        if event.type == self.Gst.EventType.CAPS:
            try:
                caps = event.parse_caps()
                if caps.get_size() != 1:
                    raise ValueError()
                s = caps.get_structure(0)
                if s.get_name() != 'video/x-h264':
                    raise ValueError()
                valid, n, d = s.get_fraction('framerate')
                self._rejected_format = dict(width=s.get_value('width'), height=s.get_value('height'),
                                            frameRate=[n, d] if valid else None)
                self._format = parsed_format(s.get_value('width'), s.get_value('height'),
                                             n if valid else 0, d if valid else 1)
                self._rejected_format = None
            except Exception:
                self._finish('phone_camera_udp_format_unsupported')
                return self.Gst.PadProbeReturn.DROP
        return self.Gst.PadProbeReturn.OK

    def _sample(self, sink):
        sample = sink.emit('pull-sample')
        if self._stopped.is_set() or sample is None:
            return self.Gst.FlowReturn.FLUSHING
        try:
            buffer = sample.get_buffer()
            pts = buffer.pts
            if (self._format is None or pts == self.Gst.CLOCK_TIME_NONE or
                    self._last_pts is not None and pts < self._last_pts):
                raise ValueError()
            now = time.monotonic()
            self._last_pts = pts
            self._last_frame = now
            value = jpeg_frame(buffer.extract_dup(0, buffer.get_size()))
            # One latest frame, not a FIFO. A paced consumer absorbs normal
            # packet-arrival jitter without dropping every second 15 fps frame.
            with self._lock:
                if self._pending_frame is not None:
                    self._rate_drops += 1
                self._pending_frame = (value, pts)
            return self.Gst.FlowReturn.OK
        except Exception:
            self._finish('phone_camera_udp_frame_failed')
            return self.Gst.FlowReturn.ERROR

    def _watch_bus(self):
        try:
            while not self._stopped.wait(max(0, self._last_delivery + 1/15 - time.monotonic())):
                self._last_delivery = time.monotonic()
                last_input = self._last_frame if self._last_frame is not None else self._first_packet
                if last_input is not None and time.monotonic() - last_input >= 3:
                    self._finish('phone_camera_udp_input_stalled')
                    break
                message = self._pipeline.get_bus().pop_filtered(
                    self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS)
                if message:
                    self._finish('phone_camera_udp_decode_failed')
                    break
                with self._lock:
                    frame = self._pending_frame
                    self._pending_frame = None
                if frame and not self._stopped.is_set():
                    self._sequence += 1
                    try:
                        self._deliver(frame[0], self._sequence, frame[1], time.monotonic_ns())
                    except Exception:
                        self._finish('phone_camera_udp_frame_failed')
                        break
        finally:
            if self._ingress:
                self._ingress.close()
            self._pipeline.set_state(self.Gst.State.NULL)
            with self._lock:
                self._pending_frame = None
            if self._reason is not None:
                try:
                    self._on_end(self._reason)
                except Exception:
                    pass

    def status(self):
        with self._lock:
            retained = len(self._pending_frame[0]) if self._pending_frame else 0
        return dict(state='stopped' if self._stopped.is_set() else
                    'receiving' if self._sequence else 'waiting',
                    errorCode=self._reason, frames=self._sequence, input=self._format,
                    rejectedFormat=self._rejected_format,
                    retainedFrameBytes=retained,
                    queueDrops=self._queue_drops, rateDrops=self._rate_drops,
                    queuePeakBytes=self._queue_peak,
                    ingress=self._ingress.status() if self._ingress else None)

    def close(self):
        with self._lock:
            self._closed = True
            self._stopped.set()
        if self._ingress:
            self._ingress.close()
        if self._watch and self._watch is not threading.current_thread():
            self._watch.join(2)
            if self._watch.is_alive():
                raise UdpCameraError('phone_camera_udp_stop_unconfirmed')
        if self._pipeline:
            self._pipeline.set_state(self.Gst.State.NULL)
        with self._lock:
            self._pending_frame = None
        self._deliver = lambda *_: None
