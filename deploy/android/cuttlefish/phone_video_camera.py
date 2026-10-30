"""Bounded uploaded MP4/H.264 -> current camera frame adapter.

Candidate component only: not registered in the member source catalog yet.
The caller owns authorization/lease and stops this process on revocation.
Input is a sealed anonymous fd supplied by the protected-object transfer, never
a URL or arbitrary path. Audio is discarded before decoding. No recording.
"""
import fcntl
import os
import stat
import threading

from phone_camera_input import jpeg_frame

# This is the integer representation shared with the JSON control plane, not a
# product file-size allowance. Actual encrypted-volume space admits uploads.
MAX_INPUT = 2**53 - 1


class VideoCameraError(RuntimeError):
    pass


def fail(code):
    raise VideoCameraError('phone_camera_video_' + code)


def source_format(width, height, numerator, denominator):
    if (any(type(v) is not int for v in (width, height, numerator, denominator))
            or not 1 <= width < 2**31 or not 1 <= height < 2**31
            or denominator <= 0 or numerator <= 0):
        fail('format_unsupported')
    # Account for H.264 reference pictures and colour-conversion work buffers
    # against this phone's actual memory, rather than rejecting all 4K inputs.
    from pathlib import Path
    available = os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    try:
        limit = Path('/sys/fs/cgroup/memory.max').read_text().strip()
        used = int(Path('/sys/fs/cgroup/memory.current').read_text())
        if limit != 'max':
            available = min(available, max(0, int(limit)-used))
    except (OSError, ValueError):
        pass
    if width * height * 32 > available:
        fail('memory_unavailable')
    return dict(width=width, height=height, frameRate=[numerator, denominator])


def sealed_input(fd):
    if type(fd) is not int or fd < 0:
        fail('input_invalid')
    try:
        info = os.fstat(fd)
        required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        try:
            immutable = fcntl.fcntl(fd, fcntl.F_GET_SEALS) & required == required
        except OSError:
            immutable = False
        if not immutable:
            # Completed, unlinked private file on the encrypted phone volume.
            # The writer is closed before this read-only fd is handed over.
            immutable = (info.st_nlink == 0 and info.st_uid == os.geteuid()
                         and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_INPUT or not immutable:
            fail('input_invalid')
        # The component supports MP4 only, without a generic URI/decoder chooser.
        if os.pread(fd, 8, 0)[4:8] != b'ftyp':
            fail('format_unsupported')
        return os.dup(fd)
    except (OSError, ValueError):
        fail('input_invalid')


class VideoCameraSource:
    """One capped file decoder, paced by media timestamps, at most 15 fps.

    Aspect ratio and MP4 orientation are applied before 640x480 letterboxing.
    Sequence stays monotonic across loops; loopIndex discloses timestamp resets.
    Run inside the phone's existing cgroup and a supervised disposable process.
    """
    def __init__(self, fd, *, loop, deliver, on_end=lambda reason: None):
        if type(loop) is not bool or not callable(deliver) or not callable(on_end):
            fail('configuration_invalid')
        self._fd = sealed_input(fd)
        self.loop = loop
        self._deliver, self._on_end = deliver, on_end
        self._stop = threading.Event()
        self._state_lock = threading.Lock()
        self._closed = False
        self._ended = False
        self._end_reason = None
        self._linked = False
        self._sequence = 0
        self._loop_index = 0
        self._last_pts = None
        self._pipeline = None
        self._watch = None
        self.input_format = None
        self.duration_ns = None
        try:
            import gi
            gi.require_version('Gst', '1.0')
            from gi.repository import Gst
            Gst.init(None)
            self.Gst = Gst
            self._pipeline = Gst.Pipeline.new(None)
            self._file = Gst.ElementFactory.make('filesrc')
            self._demux = Gst.ElementFactory.make('qtdemux')
            if not self._pipeline or not self._file or not self._demux:
                fail('runtime_unavailable')
            self._file.set_property('location', '/proc/self/fd/' + str(self._fd))
            self._pipeline.add(self._file)
            self._pipeline.add(self._demux)
            if not self._file.link(self._demux):
                fail('runtime_unavailable')
            self._video = Gst.parse_bin_from_description(
                'queue max-size-buffers=2 max-size-bytes=4194304 max-size-time=0 ! '
                'h264parse name=video-parser ! openh264dec ! '
                'videoconvert ! videoflip method=automatic ! '
                'videoscale add-borders=true ! videorate drop-only=true max-rate=15 ! '
                'video/x-raw,width=640,height=480,pixel-aspect-ratio=1/1,framerate=(fraction)[1/1,15/1] ! '
                'jpegenc quality=85 ! appsink name=video-frame emit-signals=true '
                'max-buffers=1 drop=true sync=true enable-last-sample=false', True)
            self._pipeline.add(self._video)
            self._sink = self._video.get_by_name('video-frame')
            self._sink.connect('new-sample', self._sample)
            self._video.get_by_name('video-parser').get_static_pad('src').add_probe(
                Gst.PadProbeType.EVENT_DOWNSTREAM, self._format_event)
            self._demux.connect('pad-added', self._pad_added)
            self._demux.connect('no-more-pads', self._no_more_pads)
            # Discover the declared duration and parsed dimensions before any
            # frames leave the decoder. Preroll remains bounded by the process
            # budget and five-second startup timeout.
            if self._pipeline.set_state(Gst.State.PAUSED) == Gst.StateChangeReturn.FAILURE:
                fail('decode_failed')
            state, _, _ = self._pipeline.get_state(5 * Gst.SECOND)
            if self._stop.is_set() or state != Gst.StateChangeReturn.SUCCESS or self.input_format is None:
                fail('format_unsupported')
            ok, duration = self._pipeline.query_duration(Gst.Format.TIME)
            if not ok or duration <= 0 or duration == Gst.CLOCK_TIME_NONE:
                fail('duration_unsupported')
            self.duration_ns = duration
            if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                fail('decode_failed')
            self._watch = threading.Thread(target=self._watch_bus, daemon=True)
            self._watch.start()
        except BaseException:
            self.close()
            raise

    def _finish(self, reason):
        with self._state_lock:
            if self._ended or self._closed:
                return
            self._ended = True
            self._end_reason = reason
            self._stop.set()

    def _caps(self, caps):
        if caps is None or caps.get_size() != 1:
            fail('format_unsupported')
        s = caps.get_structure(0)
        if s.get_name() != 'video/x-h264':
            fail('format_unsupported')
        # GstFraction has no generic PyGObject conversion in the pinned image.
        # Use the typed accessor; do not parse an untrusted caps string.
        valid, numerator, denominator = s.get_fraction('framerate')
        return source_format(s.get_value('width'), s.get_value('height'),
                             numerator if valid else 0, denominator if valid else 0)

    def _format_event(self, pad, info):
        if self._stop.is_set():
            return self.Gst.PadProbeReturn.DROP
        event = info.get_event()
        if event.type == self.Gst.EventType.CAPS:
            try:
                self.input_format = self._caps(event.parse_caps())
            except Exception:
                self._finish('phone_camera_video_format_unsupported')
                return self.Gst.PadProbeReturn.DROP
        return self.Gst.PadProbeReturn.OK

    def _pad_added(self, demux, pad):
        caps = pad.get_current_caps()
        if self._stop.is_set() or caps is None or caps.get_size() != 1:
            self._finish('phone_camera_video_format_unsupported')
            return
        name = caps.get_structure(0).get_name()
        if name.startswith('audio/'):
            sink = self.Gst.ElementFactory.make('fakesink')
            sink.set_property('sync', False)
            sink.set_property('async', False)
            sink.set_property('enable-last-sample', False)
            self._pipeline.add(sink)
            sink.sync_state_with_parent()
            if pad.link(sink.get_static_pad('sink')) != self.Gst.PadLinkReturn.OK:
                self._finish('phone_camera_video_decode_failed')
            return
        try:
            # MP4 demux caps may omit frame rate (notably variable-timestamp
            # phone videos). h264parse obtains it from the bitstream. Reject
            # other codecs here, but validate dimensions/rate on parser CAPS,
            # before openh264dec or any camera frame receives the stream.
            if name != 'video/x-h264':
                fail('format_unsupported')
            if self._linked:
                fail('format_unsupported')
            self._linked = True
            if pad.link(self._video.get_static_pad('sink')) != self.Gst.PadLinkReturn.OK:
                fail('decode_failed')
        except Exception:
            self._finish('phone_camera_video_format_unsupported')

    def _no_more_pads(self, demux):
        if not self._linked:
            self._finish('phone_camera_video_format_unsupported')

    def _sample(self, sink):
        sample = sink.emit('pull-sample')
        if self._stop.is_set() or sample is None:
            return self.Gst.FlowReturn.FLUSHING
        buffer = sample.get_buffer()
        pts = buffer.pts
        try:
            if (pts == self.Gst.CLOCK_TIME_NONE
                    or self._last_pts is not None and pts < self._last_pts):
                fail('timestamp_invalid')
            value = jpeg_frame(buffer.extract_dup(0, buffer.get_size()))
            self._sequence += 1
            self._last_pts = pts
            self._deliver(value, self._sequence, pts, self._loop_index)
            return self.Gst.FlowReturn.OK
        except Exception:
            self._finish('phone_camera_video_frame_failed')
            return self.Gst.FlowReturn.ERROR

    def _watch_bus(self):
        try:
            self._read_bus()
        finally:
            # Native teardown and the end callback run off the streaming
            # thread. EOS/error must stop decoding even if the owner is idle.
            self._pipeline.set_state(self.Gst.State.NULL)
            self._release_fd()
            if self._end_reason is not None:
                try:
                    self._on_end(self._end_reason)
                except Exception:
                    pass  # The native source has already stopped.

    def _read_bus(self):
        Gst = self.Gst
        while not self._stop.wait(.05):
            message = self._pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if not message:
                continue
            if message.type == Gst.MessageType.ERROR:
                self._finish('phone_camera_video_decode_failed')
                return
            if not self.loop:
                self._finish('ended')
                return
            self._loop_index += 1
            self._last_pts = None
            if not self._pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 0):
                self._finish('phone_camera_video_seek_failed')
                return

    def close(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
        if self._watch and self._watch is not threading.current_thread():
            self._watch.join(2)
        if self._pipeline is not None:
            self._pipeline.set_state(self.Gst.State.NULL)
        self._release_fd()
        self._deliver = lambda *_: None

    def _release_fd(self):
        with self._state_lock:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None
