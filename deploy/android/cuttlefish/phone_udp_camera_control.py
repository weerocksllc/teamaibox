"""Phone-private network camera handoff; only an already-bound UDP socket."""
import os
from pathlib import Path
import signal
import socket
import stat

from phone_camera_input import CameraInputError
from phone_runtime import closed_json, validate_config
from phone_udp_camera_session import validate_start
from phone_usb_camera_control import UsbServer
from phone_video_camera_control import VideoCameraControl, VideoProcess, serve

SOCKET=Path('/tmp/phone-camera-input/udp.sock')


def own_socket(fd):
    if type(fd) is not int or fd<0:raise CameraInputError('phone_camera_udp_socket_invalid')
    with socket.fromfd(fd,socket.AF_INET,socket.SOCK_DGRAM) as source:
        if (source.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)!=socket.SOCK_DGRAM
                or source.getsockname()[0]=='0.0.0.0' or source.getsockname()[1]<1024
                or source.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR)
                or hasattr(socket,'SO_REUSEPORT') and source.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEPORT)):
            raise CameraInputError('phone_camera_udp_socket_invalid')
        return os.dup(source.fileno())


class UdpProcess(VideoProcess):
    worker='/opt/teamaibox/phone_udp_camera_worker.py'


class UdpCameraControl(VideoCameraControl):
    source_kind='udp'
    validate=staticmethod(validate_start)
    own_fd=staticmethod(own_socket)

    def __init__(self,config,**kwargs):
        super().__init__(config,factory=kwargs.pop('factory',UdpProcess),**kwargs)

    def start(self,value,fd):
        value=self.validate(value,self.config);grant=value['grant'];owned=self.own_fd(fd)
        try:
            with socket.fromfd(owned,socket.AF_INET,socket.SOCK_DGRAM) as source:
                if source.getsockname()!=(value['policy']['listenAddress'],value['policy']['listenPort']):
                    raise CameraInputError('phone_camera_udp_socket_invalid')
            with self.lock:
                if self.closed or self.active is not None:raise CameraInputError('phone_camera_source_stopped')
                if self.broker({'action':'status','grant':grant})['state']!='waiting':raise CameraInputError('phone_camera_source_stopped')
                active={'grant':grant,'process':self.factory(value,owned)};self.active=active
        finally:os.close(owned)
        try:
            result=active['process'].answer()
            with self.lock:
                if self.closed or self.active is not active or not active['process'].alive():raise CameraInputError('phone_camera_source_stopped')
                if (set(result)!={'sourceId','state'} or result['sourceId']!=grant['sourceId']
                        or result['state'] not in ('waiting','receiving')
                        or self.broker({'action':'status','grant':grant})['state'] not in ('waiting','receiving')):
                    raise CameraInputError('phone_camera_source_stopped')
                return result
        except BaseException:
            with self.lock:
                if self.active is active:self._drop()
            raise


if __name__=='__main__':
    info=SOCKET.parent.lstat()
    if os.getuid()!=10001 or not stat.S_ISDIR(info.st_mode) or info.st_uid!=10001 or stat.S_IMODE(info.st_mode)!=0o700:
        raise CameraInputError('phone_camera_directory_invalid')
    signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(SystemExit(0)))
    serve(validate_config(closed_json(Path('/run/phone/config.json').read_bytes())),SOCKET,
          UdpCameraControl,UsbServer,b'N',starter_uid=0)
