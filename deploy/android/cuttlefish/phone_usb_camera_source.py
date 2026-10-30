"""Bounded node-local USB capture candidate, not enabled in the product.

Only a trusted launcher may map an authorized exact camera to the fixed path.
No URLs, host path input, audio, stream recording, network or auto-reconnect.
The caller owns the device lease and the same phone resource budget; it must
supervise native teardown in a disposable process and revoke on run changes.
"""
import os
import stat
import threading
import time

from phone_camera_input import jpeg_frame
from phone_usb_camera_devices import UsbCameraError, choose_mode, query_capabilities, query_modes

DEVICE = '/dev/phone-camera-usb0'


class UsbCameraSource:
    def __init__(self, *, pixel_format, deliver, authorized, on_end=lambda reason: None):
        if pixel_format not in ('MJPG', 'YUYV') or not all(callable(f) for f in (deliver, authorized, on_end)):
            raise UsbCameraError('phone_camera_usb_request_invalid')
        info = os.lstat(DEVICE)
        if not stat.S_ISCHR(info.st_mode):
            raise UsbCameraError('phone_camera_usb_device_invalid')
        if not authorized():
            raise UsbCameraError('phone_camera_usb_permission_required')
        self._deliver, self._authorized, self._on_end = deliver, authorized, on_end
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._pipeline = self._watch = None
        self._closed = False
        self._reason = None
        self._sequence = 0
        self._last = None
        self._first = None
        self._pts = None
        self._format = None
        self._max_bytes = 0
        self._ready = threading.Event()
        self.diagnostic = None
        try:
            fd = os.open(DEVICE, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                opened = os.fstat(fd)
                if (opened.st_ino, opened.st_rdev) != (info.st_ino, info.st_rdev):
                    raise UsbCameraError('phone_camera_usb_device_changed')
                capabilities = query_capabilities(fd)
                if capabilities is None or capabilities['captureType'] != 1:
                    raise UsbCameraError('phone_camera_usb_format_unsupported')
                self.input_format = choose_mode(query_modes(fd, capabilities['formats']), pixel_format)
            finally:
                os.close(fd)
            import gi
            gi.require_version('Gst', '1.0')
            from gi.repository import Gst
            Gst.init(None)
            self.Gst = Gst
            mode = self.input_format
            dimensions = (f",width={mode['width']},height={mode['height']},"
                          f"framerate={mode['frameRate'][0]}/{mode['frameRate'][1]}")
            prefix = ('image/jpeg' + dimensions + ' ! jpegdec' if pixel_format == 'MJPG'
                      else 'video/x-raw,format=YUY2' + dimensions)
            self._pipeline = Gst.parse_launch('v4l2src name=camera io-mode=mmap do-timestamp=true ! '
                + prefix + ' ! videoconvert ! videoscale add-borders=true ! videorate drop-only=true max-rate=15 ! '
                'video/x-raw,width=640,height=480,pixel-aspect-ratio=1/1,framerate=15/1 ! '
                'jpegenc quality=85 ! appsink name=frames emit-signals=true '
                'max-buffers=1 drop=true sync=false enable-last-sample=false')
            camera = self._pipeline.get_by_name('camera')
            camera.set_property('device', DEVICE)
            sink = self._pipeline.get_by_name('frames')
            sink.connect('new-sample', self._sample)
            self._started = time.monotonic()
            if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise UsbCameraError('phone_camera_usb_capture_failed')
            self._watch = threading.Thread(target=self._watch_bus, daemon=True)
            self._watch.start()
            deadline = time.monotonic() + 5
            while not self._ready.wait(.05):
                if self._stop.is_set() or time.monotonic() >= deadline:
                    error = UsbCameraError(self._reason or 'phone_camera_usb_first_frame_timeout')
                    error.diagnostic = self.diagnostic
                    raise error
        except BaseException:
            self.close()
            raise

    def _sample(self, sink):
        if self._stop.is_set():
            return self.Gst.FlowReturn.FLUSHING
        try:
            if not self._authorized():
                self._finish('phone_camera_usb_permission_revoked')
                return self.Gst.FlowReturn.FLUSHING
            sample = sink.emit('pull-sample')
            buffer = sample.get_buffer()
            caps = sample.get_caps().get_structure(0)
            if caps.get_value('width') != 640 or caps.get_value('height') != 480:
                raise UsbCameraError('phone_camera_usb_format_unsupported')
            if not 0 < buffer.get_size() <= 2 * 1024**2 or buffer.pts == self.Gst.CLOCK_TIME_NONE:
                raise UsbCameraError('phone_camera_usb_frame_invalid')
            now = time.monotonic()
            if self._pts is not None and buffer.pts <= self._pts:
                raise UsbCameraError('phone_camera_usb_timestamp_invalid')
            frame = jpeg_frame(buffer.extract_dup(0, buffer.get_size()))
            # Stop and delivery share a lock: after close returns no callback
            # can deliver another private frame. The callback must be bounded.
            with self._lock:
                if self._stop.is_set():
                    return self.Gst.FlowReturn.FLUSHING
                self._deliver(frame, self._sequence + 1, int(buffer.pts))
                self._sequence += 1
                self._pts = int(buffer.pts)
                self._last = now
                if self._first is None:
                    self._first = now
                self._max_bytes = max(self._max_bytes, len(frame))
                self._format = dict(width=640, height=480, pixelFormat='MJPG', frameRate=[15, 1])
                self._ready.set()
            return self.Gst.FlowReturn.OK
        except Exception as error:
            self._finish(str(error) if isinstance(error, UsbCameraError) else 'phone_camera_usb_capture_failed')
            return self.Gst.FlowReturn.ERROR

    def _finish(self, reason):
        if not self._stop.is_set():
            self._reason = reason
            self._stop.set()

    def _watch_bus(self):
        bus = self._pipeline.get_bus()
        try:
            while not self._stop.is_set():
                message = bus.timed_pop_filtered(100 * self.Gst.MSECOND,
                          self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS)
                if message is not None:
                    if message.type == self.Gst.MessageType.ERROR:
                        error, debug = message.parse_error()
                        self.diagnostic = dict(domain=error.domain, code=error.code,
                            message=error.message[:400], debug=(debug or '')[:800])
                    self._finish('phone_camera_usb_device_unavailable')
                elif not self._authorized():
                    self._finish('phone_camera_usb_permission_revoked')
                elif time.monotonic() - (self._last or self._started) > (2 if self._ready.is_set() else 5):
                    self._finish('phone_camera_usb_input_stalled')
        except Exception:
            self._finish('phone_camera_usb_permission_revoked')
        finally:
            # Never hold the callback lock while stopping a GStreamer task:
            # set_state(NULL) may wait for that task's final callback.
            self._pipeline.set_state(self.Gst.State.NULL)
            if self._reason is not None:
                self._on_end(self._reason)

    def status(self):
        with self._lock:
            return dict(state='stopped' if self._stop.is_set() else 'receiving',
                        frames=self._sequence, input=self.input_format, output=self._format, recording=False,
                        largestFrameBytes=self._max_bytes,
                        firstFrameSeconds=None if self._first is None else round(self._first - self._started, 4),
                        errorCode=self._reason)

    def close(self):
        self._stop.set()
        if self._watch is not None and self._watch is not threading.current_thread():
            self._watch.join(3)
            if self._watch.is_alive():
                raise UsbCameraError('phone_camera_usb_teardown_timeout')
        if self._pipeline is not None:
            self._pipeline.set_state(self.Gst.State.NULL)
        with self._lock:
            self._closed = True
