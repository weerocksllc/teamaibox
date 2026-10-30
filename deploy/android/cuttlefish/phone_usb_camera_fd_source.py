"""USB frames from one passed descriptor, decoded inside the phone budget.

No device path or microphone is opened. The fixed Camera HAL currently takes
640x480 JPEG; input is letterboxed, never stretched. Only the newest captured
frame is decoded, so a temporarily slow guest cannot build a video backlog.
"""
import threading
import time

from phone_camera_input import jpeg_frame
from phone_usb_camera_devices import UsbCameraError
from phone_usb_camera_fd import UsbCameraFd


class UsbFrameConverter:
    def __init__(self, mode):
        import gi
        gi.require_version('Gst', '1.0')
        from gi.repository import Gst
        Gst.init(None)
        self.Gst = Gst
        self.pipeline = None
        pixel = mode['pixelFormat']
        prefix = ('image/jpeg' if pixel == 'MJPG' else 'video/x-raw,format=YUY2')
        caps = (prefix + f",width={mode['width']},height={mode['height']},"
                'pixel-aspect-ratio=1/1,framerate=0/1')
        try:
            self.pipeline = Gst.parse_launch('appsrc name=input is-live=true format=time block=false '
                'max-buffers=1 leaky-type=downstream ! '
                + ('jpegdec ! ' if pixel == 'MJPG' else '')
                + 'videoconvert ! video/x-raw,format=RGB ! videoscale add-borders=true ! '
                'video/x-raw,format=RGB,width=640,height=480,pixel-aspect-ratio=1/1 ! '
                # RGB keeps border pixels black through scaling. Convert back
                # to I420 before JPEG: Android's external camera MJPG path
                # expects YCbCr, not Adobe RGB JPEG (component IDs R/G/B).
                'videoconvert ! video/x-raw,format=I420,colorimetry=1:4:16:4 ! jpegenc quality=85 ! '
                'appsink name=output sync=false max-buffers=1 drop=true '
                'enable-last-sample=false')
            self.input = self.pipeline.get_by_name('input')
            self.input.set_property('caps', Gst.Caps.from_string(caps))
            self.output = self.pipeline.get_by_name('output')
            if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise UsbCameraError('phone_camera_usb_capture_failed')
        except BaseException:
            self.close()
            raise

    def convert(self, raw, pts, stopped):
        frame = self.Gst.Buffer.new_allocate(None, len(raw), None)
        frame.fill(0, raw)
        frame.pts = pts
        if self.input.emit('push-buffer', frame) != self.Gst.FlowReturn.OK:
            raise UsbCameraError('phone_camera_usb_capture_failed')
        deadline = time.monotonic() + 1
        while not stopped.is_set() and time.monotonic() < deadline:
            sample = self.output.emit('try-pull-sample', 50 * self.Gst.MSECOND)
            if sample is not None:
                buffer = sample.get_buffer()
                if not 0 < buffer.get_size() <= 640 * 480 * 2:
                    raise UsbCameraError('phone_camera_usb_frame_invalid')
                return jpeg_frame(buffer.extract_dup(0, buffer.get_size()))
            if self.pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS):
                raise UsbCameraError('phone_camera_usb_capture_failed')
        raise UsbCameraError('phone_camera_usb_input_stalled')

    def close(self):
        if self.pipeline is not None:
            self.pipeline.set_state(self.Gst.State.NULL)
            self.pipeline = None


class UsbCameraFdSource:
    def __init__(self, fd, *, pixel_format, deliver, authorized, on_end=lambda reason: None,
                 reader_factory=UsbCameraFd, converter_factory=UsbFrameConverter):
        if pixel_format not in ('MJPG', 'YUYV') or not all(callable(f) for f in (deliver, authorized, on_end)):
            raise UsbCameraError('phone_camera_usb_request_invalid')
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.done = threading.Event()
        self.frames = 0
        self.discarded = 0
        self.reason = None
        self.failure_stage = None
        self.failure_type = None
        self.reader = self.converter = self.thread = None
        self.deliver, self.authorized, self.on_end = deliver, authorized, on_end
        if not authorized():
            raise UsbCameraError('phone_camera_usb_permission_required')
        try:
            self.reader = reader_factory(fd, pixel_format)
            self.mode = self.reader.mode
            self.converter = converter_factory(self.mode)
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
            deadline = time.monotonic() + 5
            while not self.ready.wait(.02):
                if self.done.is_set() or time.monotonic() >= deadline:
                    raise UsbCameraError(self.reason or 'phone_camera_usb_first_frame_timeout')
        except BaseException:
            self.close()
            raise

    def _run(self):
        last = time.monotonic()
        try:
            while not self.stop.is_set():
                self.failure_stage = 'authorization'
                if not self.authorized():
                    raise UsbCameraError('phone_camera_usb_permission_revoked')
                self.failure_stage = 'capture'
                item = self.reader.read()
                if item is None:
                    if time.monotonic() - last > 2:
                        raise UsbCameraError('phone_camera_usb_input_stalled')
                    continue
                # Drain only the finite kernel capture queue, not an ever-growing
                # application queue. Retain the most recent complete frame.
                for _ in range(len(self.reader.maps)):
                    newer = self.reader.read(timeout=0)
                    if newer is None:
                        break
                    item = newer
                    self.discarded += 1
                raw, pts = item
                self.failure_stage = 'convert'
                frame = self.converter.convert(raw, pts, self.stop)
                del item, raw
                self.failure_stage = 'authorization'
                if self.stop.is_set() or not self.authorized():
                    raise UsbCameraError('phone_camera_usb_permission_revoked')
                self.failure_stage = 'deliver'
                self.deliver(frame, self.frames + 1, pts)
                del frame
                self.frames += 1
                last = time.monotonic()
                self.ready.set()
        except Exception as error:
            self.failure_type = type(error).__name__
            self.reason = str(error) if isinstance(error, UsbCameraError) else 'phone_camera_usb_capture_failed'
        finally:
            self.stop.set()
            try:
                self._release()
            finally:
                self.done.set()
                self.on_end(self.reason or 'phone_camera_source_stopped')

    def _release(self):
        # Close the physical device first, even if native codec shutdown stalls.
        if self.reader is not None:
            self.reader.close()
            self.reader = None
        if self.converter is not None:
            self.converter.close()
            self.converter = None

    def close(self):
        self.stop.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(2)
            if self.thread.is_alive():
                raise UsbCameraError('phone_camera_usb_teardown_timeout')
        if self.thread is None:
            self._release()
