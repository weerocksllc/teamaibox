"""Reuse actual Camera2 comparisons, receiving USB without any device mount."""
import array
import os
from pathlib import Path
import socket
import stat
import struct
import sys

sys.path[:0]=['/run/phone-test','/opt/teamaibox','/opt/teamaibox/camera-python']
from phone_usb_camera_fd_source import UsbCameraFdSource
from probe_phone_usb_camera_android import main


def camera_fds():
    count=0
    for path in Path('/proc/self/fd').iterdir():
        try:
            info=path.stat()
            count+=stat.S_ISCHR(info.st_mode) and os.major(info.st_rdev)==81
        except FileNotFoundError:pass
    return count


class Source(UsbCameraFdSource):
    def __init__(self,**kwargs):
        path=Path('/tmp/phone-camera-input/usb-test.sock')
        assert not path.exists() and not path.is_symlink()
        assert not list(Path('/dev').glob('video*')) and not Path('/dev/phone-camera-usb0').exists()
        received=[]
        try:
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(path));os.chmod(path,0o600);server.listen(1);server.settimeout(10)
                with server.accept()[0] as peer:
                    peer.settimeout(2)
                    assert struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]==0
                    data,anc,flags,_=peer.recvmsg(1,socket.CMSG_SPACE(4),socket.MSG_CMSG_CLOEXEC)
                    assert data==b'U' and not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC)
                    for level,kind,raw in anc:
                        assert level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS
                        fds=array.array('i');fds.frombytes(raw);received.extend(fds)
                    assert len(received)==1
                    super().__init__(received[0],**kwargs)
                    peer.sendall(b'R')
        finally:
            for fd in received:os.close(fd)
            path.unlink(missing_ok=True)
    def status(self):
        return dict(state='stopped' if self.stop.is_set() else 'receiving',frames=self.frames,
                    input=self.mode,output=dict(width=640,height=480),recording=False,errorCode=self.reason)


if __name__=='__main__':raise SystemExit(main(Source,camera_fds))
