"""Physical fd-handoff probe. No image, audio, Android or product claim."""
import array
import json
import os
from pathlib import Path
import socket
import struct
import time
from phone_usb_camera_fd import UsbCameraFd


def main():
    result=dict(status='failed',physicalUsb=True,androidTested=False,productEnabled=False,mediaSaved=False,microphoneUsed=False,cases=[])
    server=socket.socket(socket.AF_UNIX);reader=None;received=[]
    try:
        assert os.getuid()==10001 and not list(Path('/dev').glob('video*')) and not Path('/dev/phone-camera-usb0').exists()
        server.bind('/handoff/input.sock');os.chmod('/handoff/input.sock',0o600);server.listen(1);server.settimeout(20)
        for pixel in ['MJPG','YUYV']:
            with server.accept()[0] as peer:
                peer.settimeout(4)
                _,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));assert uid==0
                raw,ancillary,flags,_=peer.recvmsg(1,socket.CMSG_SPACE(4),socket.MSG_CMSG_CLOEXEC)
                assert not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) and raw==(b'M' if pixel=='MJPG' else b'Y')
                for level,kind,data in ancillary:
                    assert level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS
                    values=array.array('i');values.frombytes(data);received.extend(values)
                assert len(received)==1
                rdev=os.fstat(received[0]).st_rdev
                reader=UsbCameraFd(received[0],pixel);os.close(received.pop())
                peer.sendall(b'R');peer.setblocking(False)
                started=time.monotonic();count=maximum=0;previous=-1
                while time.monotonic()-started<6:
                    try:
                        data=peer.recv(1)
                        assert data==b'S'
                        break
                    except BlockingIOError:pass
                    frame=reader.read()
                    if frame is None:continue
                    raw,pts=frame
                    assert pts>previous and len(raw)>512
                    if pixel=='MJPG':assert raw[:2]==b'\xff\xd8' and b'\xff\xd9' in raw[-16:]
                    else:assert len(raw)==reader.mode['width']*reader.mode['height']*2
                    previous=pts;count+=1;maximum=max(maximum,len(raw));del raw,frame
                assert count>=35 and time.monotonic()-started<5
                at=time.monotonic();reader.close();reader=None
                remaining=0
                for p in Path('/proc/self/fd').iterdir():
                    try:remaining+=p.stat().st_rdev==rdev
                    except FileNotFoundError:pass
                assert remaining==0
                value=dict(format=pixel,frames=count,maximumFrameBytes=maximum,closeSeconds=round(time.monotonic()-at,4),remainingDeviceFds=remaining)
                result['cases'].append(value);peer.setblocking(True);peer.sendall(json.dumps(value).encode()+b'\n')
        result.update(status='passed',noDeviceMount=True,memoryPeakBytes=int(Path('/sys/fs/cgroup/memory.peak').read_text()),
            memorySwapBytes=int(Path('/sys/fs/cgroup/memory.swap.current').read_text()))
    except BaseException as e:result['error']=type(e).__name__+':'+str(e)[:160]
    finally:
        if reader:reader.close()
        for fd in received:os.close(fd)
        server.close()
        Path('/handoff/input.sock').unlink(missing_ok=True)
    print(json.dumps(result),flush=True)
    return int(result['status']!='passed')

if __name__=='__main__':raise SystemExit(main())
