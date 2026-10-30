"""Single-planar V4L2 MMAP input from one already-authorized file descriptor.

No path opening, USB passthrough, network, audio, recording or fallback. A
trusted node launcher checks the physical attachment and passes only that fd
to a supervised worker in the phone cgroup. This module is NOT authorization.

Kernel API: https://docs.kernel.org/userspace-api/media/v4l/mmap.html
The fixed layouts below are the Linux 64-bit ABI (ARM64 and x86_64).
"""
import errno
import fcntl
import mmap
import os
import select
import stat
import struct
import sys

from phone_usb_camera_devices import UsbCameraError, query_capabilities, query_modes, choose_mode

S_FMT = 0xC0D05605
S_PARM = 0xC0CC5616
REQBUFS = 0xC0145608
QUERYBUF, QBUF, DQBUF = 0xC0585609, 0xC058560F, 0xC0585611
STREAMON, STREAMOFF = 0x40045612, 0x40045613
MAX_FRAME = 4 * 1024**2


class UsbCameraFd:
    """Owns a duplicate; caller closes the received original immediately.

    A single worker thread calls read/close. External cancellation interrupts
    poll every 100 ms; a supervising parent kills a stuck native worker, not
    the phone or any competing camera process.
    """
    def __init__(self, fd, pixel_format):
        self.fd = None
        self.maps = []
        self.allocated = self.streaming = False
        self.last_timestamp = None
        self.frames = 0
        if sys.platform != 'linux' or struct.calcsize('P') != 8 or type(fd) is not int or fd < 0:
            raise UsbCameraError('phone_camera_usb_device_invalid')
        info = os.fstat(fd)
        if not stat.S_ISCHR(info.st_mode) or os.major(info.st_rdev) != 81 or fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDWR:
            raise UsbCameraError('phone_camera_usb_device_invalid')
        self.fd = os.dup(fd)
        try:
            os.set_inheritable(self.fd, False)
            os.set_blocking(self.fd, False)
            caps = query_capabilities(self.fd)
            if not caps or caps['captureType'] != 1:
                raise UsbCameraError('phone_camera_usb_format_unsupported')
            self.mode = choose_mode(query_modes(self.fd, caps['formats']), pixel_format)
            self._configure()
        except BaseException:
            self.close()
            raise

    def _configure(self):
        m = self.mode
        value = bytearray(208)
        struct.pack_into('=I', value, 0, 1)
        struct.pack_into('=4I', value, 8, m['width'], m['height'], int.from_bytes(m['pixelFormat'].encode(), 'little'), 0)
        try:
            fcntl.ioctl(self.fd, S_FMT, value, True)
        except OSError as e:
            if e.errno == errno.EBUSY:
                raise UsbCameraError('phone_camera_usb_busy') from None
            raise
        width, height, fourcc, _, stride, size = struct.unpack_from('=6I', value, 8)
        if (width, height, fourcc) != (m['width'], m['height'], int.from_bytes(m['pixelFormat'].encode(), 'little')) or not 0 < size <= MAX_FRAME:
            raise UsbCameraError('phone_camera_usb_format_unsupported')
        if m['pixelFormat'] == 'YUYV' and stride != width * 2:
            raise UsbCameraError('phone_camera_usb_format_unsupported')
        self.maximum_frame_bytes = size
        value = bytearray(204)
        struct.pack_into('=I', value, 0, 1)
        denominator, numerator = m['frameRate']
        struct.pack_into('=2I', value, 12, numerator, denominator)
        fcntl.ioctl(self.fd, S_PARM, value, True)
        actual_num, actual_den = struct.unpack_from('=2I', value, 12)
        if not actual_num or not 15 <= actual_den / actual_num <= 30:
            raise UsbCameraError('phone_camera_usb_format_unsupported')
        self.mode = {**m, 'frameRate': [actual_den, actual_num]}
        value = bytearray(20)
        struct.pack_into('=3I', value, 0, 3, 1, 1)
        try:
            fcntl.ioctl(self.fd, REQBUFS, value, True)
        except OSError as e:
            if e.errno == errno.EBUSY:
                raise UsbCameraError('phone_camera_usb_busy') from None
            raise
        self.allocated = True
        count = struct.unpack_from('=I', value)[0]
        if not 2 <= count <= 6:
            raise UsbCameraError('phone_camera_usb_buffer_limit')
        for index in range(count):
            buffer = self._buffer(index)
            fcntl.ioctl(self.fd, QUERYBUF, buffer, True)
            offset, length = struct.unpack_from('=I', buffer, 64)[0], struct.unpack_from('=I', buffer, 72)[0]
            if not 0 < length <= MAX_FRAME or length < size or offset % mmap.PAGESIZE:
                raise UsbCameraError('phone_camera_usb_buffer_invalid')
            self.maps.append(mmap.mmap(self.fd, length, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ | mmap.PROT_WRITE, offset=offset))
            fcntl.ioctl(self.fd, QBUF, buffer, True)
        fcntl.ioctl(self.fd, STREAMON, struct.pack('=I', 1))
        self.streaming = True

    @staticmethod
    def _buffer(index=0):
        value = bytearray(88)
        struct.pack_into('=2I', value, 0, index, 1)
        struct.pack_into('=I', value, 60, 1)
        return value

    def read(self, timeout=.1):
        if self.fd is None or not self.streaming:
            raise UsbCameraError('phone_camera_source_stopped')
        if not select.select([self.fd], [], [], timeout)[0]:
            return None
        buffer = self._buffer()
        try:
            fcntl.ioctl(self.fd, DQBUF, buffer, True)
        except BlockingIOError:
            return None
        index, _, size, flags = struct.unpack_from('=4I', buffer)
        if index >= len(self.maps):
            raise UsbCameraError('phone_camera_usb_buffer_invalid')
        try:
            if flags & 0x40:  # V4L2_BUF_FLAG_ERROR: discard corrupt frame.
                return None
            if not 0 < size <= self.maximum_frame_bytes or flags & 0xE000 != 0x2000:
                raise UsbCameraError('phone_camera_usb_frame_invalid')
            sec, usec = struct.unpack_from('=2q', buffer, 24)
            timestamp = sec * 1_000_000_000 + usec * 1000
            if sec < 0 or not 0 <= usec < 1_000_000 or self.last_timestamp is not None and timestamp <= self.last_timestamp:
                raise UsbCameraError('phone_camera_usb_timestamp_invalid')
            self.last_timestamp = timestamp
            self.frames += 1
            # One frame copy only; no history, file, or unbounded queue.
            return self.maps[index][:size], timestamp
        finally:
            fcntl.ioctl(self.fd, QBUF, buffer, True)

    def close(self):
        if self.fd is None:
            return
        try:
            if self.streaming:
                try: fcntl.ioctl(self.fd, STREAMOFF, struct.pack('=I', 1))
                except OSError: pass  # Device may have physically disappeared.
            for memory in self.maps:
                memory.close()
            self.maps.clear()
            if self.allocated:
                value = bytearray(20)
                struct.pack_into('=3I', value, 0, 0, 1, 1)
                try: fcntl.ioctl(self.fd, REQBUFS, value, True)
                except OSError: pass
        finally:
            os.close(self.fd)
            self.fd = None
            self.streaming = self.allocated = False
