"""Bounded receive-only WebRTC source for the phone's existing frame adapter.

No HTTP server, authentication database, file recording or guest access here.
The caller must supply an authorized phone/run/source lease, renew it, and
close this adapter when it expires. This module is not yet a published source.
GStreamer owns SRTP/DTLS and decoding; only one current JPEG leaves this class.
"""
import ipaddress
import re
import threading
import time


# RTP buffers are packets, not pictures. Dropping any before depayloading or
# decoding can damage a VP8 frame and the reference frames which follow it.
# Bound latency by discarding only complete decoded pictures. Ask the sender
# for a fresh keyframe after actual transport loss instead of showing damage.
RTP_DECODE_CHAIN = (
    'rtpvp8depay request-keyframe=true wait-for-keyframe=true ! vp8dec threads=1 ! '
    'queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! ')


class BrowserCameraError(RuntimeError):
    pass


def error(code):
    raise BrowserCameraError('phone_camera_browser_' + code)


def address(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        error('address_invalid')
    if ip.version != 4 or ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_reserved:
        error('address_invalid')
    return str(ip)


def offer_sdp(raw, allowed_addresses):
    """One video-only VP8 uplink. Never accept an audio/data/relay offer.

    The allowed numeric addresses come from trusted signalling policy, not
    from the caller's SDP. No DNS, arbitrary STUN or TURN connection is made.
    Browser camera permission is obtained before gathering host candidates.
    """
    if not isinstance(raw, str) or not 1 <= len(raw.encode()) <= 65536 or '\0' in raw:
        error('offer_invalid')
    lines = raw.replace('\r\n', '\n').splitlines()
    if not lines or lines[0] != 'v=0' or any(len(line) > 4096 for line in lines):
        error('offer_invalid')
    media = [line for line in lines if line.startswith('m=')]
    if len(media) != 1 or not re.fullmatch(r'm=video [1-9][0-9]{0,4} UDP/TLS/RTP/SAVPF (?:[0-9]{1,3} ?)+', media[0]):
        error('video_only_required')
    if [line for line in lines if line in ('a=sendonly','a=sendrecv','a=recvonly','a=inactive')] != ['a=sendonly']:
        error('video_only_required')
    if 'a=rtcp-mux' not in lines or 'a=setup:actpass' not in lines:
        error('offer_invalid')
    fingerprints = [line for line in lines if line.startswith('a=fingerprint:')]
    if len(fingerprints) != 1 or not re.fullmatch(r'a=fingerprint:sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}', fingerprints[0]):
        error('encryption_required')
    codecs = [line for line in lines if line.startswith('a=rtpmap:')]
    if not codecs or not any(re.fullmatch(r'a=rtpmap:[0-9]+ VP8/90000', line, re.I) for line in codecs):
        error('codec_unsupported')
    if any(not re.fullmatch(r'a=rtpmap:[0-9]+ (?:VP8|rtx)/90000', line, re.I) for line in codecs):
        error('codec_unsupported')
    allowed = {address(value) for value in allowed_addresses}
    candidates = [line for line in lines if line.startswith('a=candidate:')]
    if not 1 <= len(candidates) <= 8:
        error('candidate_invalid')
    for line in candidates:
        fields = line[len('a=candidate:'):].split()
        if len(fields) < 8 or fields[1] != '1' or fields[2].lower() != 'udp' or fields[6:8] != ['typ','host']:
            error('candidate_invalid')
        if address(fields[4]) not in allowed or not fields[5].isdigit() or not 1024 <= int(fields[5]) <= 65535:
            error('candidate_invalid')
    return '\r\n'.join(lines).rstrip('\r\n') + '\r\n'


class BrowserCameraReceiver:
    """One source, one VP8 stream, 640x480 JPEG at no more than 15 fps.

    At most two complete decoded frames and one JPEG wait for the consumer.
    Backpressure drops old pictures, never partial RTP or VP8 reference data.
    This class never supplies a cached private frame after close/failure.
    """
    def __init__(self, *, bind_address, first_port, last_port, allowed_addresses,
                 deliver, on_failure=lambda code: None):
        if not callable(deliver) or not callable(on_failure):
            error('configuration_invalid')
        self.bind_address = address(bind_address)
        self.allowed_addresses = {address(v) for v in allowed_addresses}
        if not self.allowed_addresses or type(first_port) is not int or type(last_port) is not int or not 1024 <= first_port <= last_port <= 65535 or last_port-first_port > 49:
            error('configuration_invalid')
        import gi
        gi.require_version('Gst', '1.0')
        gi.require_version('GstSdp', '1.0')
        gi.require_version('GstWebRTC', '1.0')
        gi.require_version('Nice', '0.1')
        from gi.repository import Gst, GstSdp, GstWebRTC, Nice
        Gst.init(None)
        self.Gst, self.GstSdp, self.GstWebRTC = Gst, GstSdp, GstWebRTC
        self._deliver, self._on_failure = deliver, on_failure
        self._lock = threading.RLock()
        self._closed = False
        self._offered = False
        self._linked = False
        self._failed = False
        self._sequence = 0
        self._last_frame_at = None
        self._gathered = threading.Event()
        self._pipeline = None
        self._webrtc = None
        self._source_pad = None
        self._watch_stop = threading.Event()
        try:
            self._pipeline = Gst.Pipeline.new(None)
            self._webrtc = Gst.ElementFactory.make('webrtcbin', 'browser-camera')
            if self._pipeline is None or self._webrtc is None:
                error('runtime_unavailable')
            self._webrtc.set_property('bundle-policy', 'max-bundle')
            self._webrtc.set_property('latency', 100)
            ice = self._webrtc.get_property('ice-agent')
            # PyGObject wrappers for the native ICE objects must outlive the
            # pipeline. Releasing these local wrappers at constructor return
            # can dispose the floating native object before SDP negotiation.
            self._ice = ice
            ice.set_property('min-rtp-port', first_port)
            ice.set_property('max-rtp-port', last_port)
            ice.set_property('ice-tcp', False)
            ice.set_property('ice-udp', True)
            nic = ice.get_property('agent')
            self._nice = nic
            local = Nice.Address.new()
            if not local.set_from_string(self.bind_address) or not nic.add_local_address(local):
                error('address_invalid')
            self._pipeline.add(self._webrtc)
            # GStreamer videoscale adds letterboxing, never crops/stretches a
            # portrait image into the Android camera's fixed 4:3 format.
            self._video = Gst.parse_bin_from_description(
                RTP_DECODE_CHAIN +
                'videorate drop-only=true ! video/x-raw,framerate=15/1 ! '
                'videoconvert ! videoscale add-borders=true ! '
                'video/x-raw,width=640,height=480,pixel-aspect-ratio=1/1 ! '
                'jpegenc quality=85 ! appsink name=camera-frame emit-signals=true '
                'max-buffers=1 drop=true sync=false enable-last-sample=false', True)
            self._pipeline.add(self._video)
            self._sink = self._video.get_by_name('camera-frame')
            self._sink.connect('new-sample', self._sample)
            self._webrtc.connect('pad-added', self._pad_added)
            self._webrtc.connect('notify::ice-gathering-state', self._gathering)
            self._webrtc.connect('notify::connection-state', self._connection)
            if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                error('pipeline_failed')
            self._watch = threading.Thread(target=self._watch_bus, daemon=True)
            self._watch.start()
        except Exception:
            self.close()
            raise

    def _fail(self, code):
        # Never log SDP, ICE credentials, exception text or frame content.
        if self._closed or self._failed:
            return
        self._failed = True
        self._gathered.set()
        self._on_failure('phone_camera_browser_' + code)

    def _watch_bus(self):
        while not self._watch_stop.wait(.1):
            if self._pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS):
                self._fail('stream_failed')
                return

    def _pad_added(self, element, pad):
        caps = pad.get_current_caps()
        if caps is None:
            caps = pad.query_caps(None)
        structure = caps.get_structure(0) if caps and caps.get_size() == 1 else None
        if (self._closed or self._failed or self._linked or structure is None or
            structure.get_name() != 'application/x-rtp' or structure.get_string('media') != 'video' or
            structure.get_string('encoding-name') != 'VP8'):
            self._fail('video_only_required')
            return
        self._linked = True
        self._source_pad = pad
        if pad.link(self._video.get_static_pad('sink')) != self.Gst.PadLinkReturn.OK:
            self._fail('pipeline_failed')

    def _sample(self, sink):
        sample = sink.emit('pull-sample')
        if self._closed or self._failed or sample is None:
            return self.Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        caps = sample.get_caps()
        structure = caps.get_structure(0) if caps and caps.get_size() == 1 else None
        if buffer is None or structure is None or structure.get_value('width') != 640 or structure.get_value('height') != 480 or not 4 < buffer.get_size() <= 614400:
            self._fail('frame_invalid')
            return self.Gst.FlowReturn.ERROR
        try:
            # Callback writes to the existing phone camera input; no frame
            # history is retained by this source. It must be bounded/nonblocking.
            self._deliver(buffer.extract_dup(0, buffer.get_size()), self._sequence)
            self._sequence += 1
            self._last_frame_at = time.monotonic()
        except Exception:
            self._fail('source_stopped')
            return self.Gst.FlowReturn.ERROR
        return self.Gst.FlowReturn.OK

    def _gathering(self, element, _):
        if element.get_property('ice-gathering-state') == self.GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            self._gathered.set()

    def _connection(self, element, _):
        if element.get_property('connection-state') in (self.GstWebRTC.WebRTCPeerConnectionState.FAILED, self.GstWebRTC.WebRTCPeerConnectionState.CLOSED):
            self._fail('disconnected')

    def _promise(self, command, *values):
        ready = threading.Event()
        promise = self.Gst.Promise.new_with_change_func(lambda *_: ready.set(), None, None)
        self._webrtc.emit(command, *values, promise)
        if not ready.wait(3):
            promise.interrupt()
            error('negotiation_failed')
        if promise.wait() != self.Gst.PromiseResult.REPLIED:
            error('negotiation_failed')
        reply = promise.get_reply()
        if reply is not None and reply.has_field('error'):
            error('negotiation_failed')
        return reply

    def offer(self, raw):
        sdp = offer_sdp(raw, self.allowed_addresses)
        with self._lock:
            if self._closed or self._failed or self._offered:
                error('source_stopped')
            self._offered = True
            _, message = self.GstSdp.SDPMessage.new()
            if self.GstSdp.sdp_message_parse_buffer(sdp.encode(), message) != self.GstSdp.SDPResult.OK:
                error('offer_invalid')
            remote = self.GstWebRTC.WebRTCSessionDescription.new(self.GstWebRTC.WebRTCSDPType.OFFER, message)
            self._promise('set-remote-description', remote)
            reply = self._promise('create-answer', None)
            if reply is None or reply.has_field('error') or not reply.has_field('answer'):
                error('negotiation_failed')
            answer = reply.get_value('answer')
            self._promise('set-local-description', answer)
        if not self._gathered.wait(3) or self._closed or self._failed:
            error('negotiation_failed')
        answer = self._webrtc.get_property('local-description').sdp.as_text()
        if 'm=audio' in answer or 'm=application' in answer or len(answer.encode()) > 65536:
            error('video_only_required')
        return answer

    def status(self):
        return dict(state='stopped' if self._closed or self._failed else 'receiving' if self._last_frame_at is not None and time.monotonic()-self._last_frame_at < 1 else 'waiting',
                    framesDelivered=self._sequence, retainedFrameBytes=0)

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._watch_stop.set()
            self._gathered.set()
            if self._pipeline is not None:
                self._pipeline.set_state(self.Gst.State.NULL)
            self._last_frame_at = None
