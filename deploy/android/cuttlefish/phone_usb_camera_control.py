#!/usr/bin/python3
"""Accept one already-open USB device into this phone without remapping /dev.

Only the node's trusted root handoff can start a camera. The phone uid can
close/query it; expiry also propagates through the existing grant broker.
The existing broker independently requires the current owner/run grant.
"""
import fcntl
import os
from pathlib import Path
import signal
import socket
import stat
import struct

from phone_camera_input import CameraInputError, PrivateServer
from phone_runtime import closed_json, validate_config
from phone_usb_camera_session import validate_start
from phone_video_camera_control import VideoCameraControl, VideoProcess, serve

SOCKET = Path('/tmp/phone-camera-input/usb.sock')


def own_device(fd):
    if type(fd) is not int or fd < 0:
        raise CameraInputError('phone_camera_usb_device_invalid')
    info = os.fstat(fd)
    if (not stat.S_ISCHR(info.st_mode) or os.major(info.st_rdev) != 81
            or fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDWR):
        raise CameraInputError('phone_camera_usb_device_invalid')
    owned = os.dup(fd)
    os.set_inheritable(owned, False)
    return owned


class UsbProcess(VideoProcess):
    worker = '/opt/teamaibox/phone_usb_camera_worker.py'


class UsbCameraControl(VideoCameraControl):
    source_kind = 'usb'
    validate = staticmethod(validate_start)
    own_fd = staticmethod(own_device)

    def __init__(self, config, **kwargs):
        super().__init__(config, factory=kwargs.pop('factory', UsbProcess), **kwargs)


class UsbServer(PrivateServer):
    def verify_request(self, request, address):
        # root runs the fixed node helper, not the Android guest. The socket is
        # private to this container's run; no root TCP endpoint is introduced.
        _, uid, _ = struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid in (0, 10001)


if __name__ == '__main__':
    info = SOCKET.parent.lstat()
    if os.getuid() != 10001 or not stat.S_ISDIR(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o700:
        raise CameraInputError('phone_camera_directory_invalid')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    serve(validate_config(closed_json(Path('/run/phone/config.json').read_bytes())), SOCKET,
          UsbCameraControl, UsbServer, b'U', starter_uid=0)
