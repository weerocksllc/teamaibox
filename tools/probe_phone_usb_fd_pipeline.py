"""Physical FD capture + actual pixel conversion. Never saves camera content."""
import array
import json
import os
from pathlib import Path
import socket
import struct
import threading
import time
import traceback

from phone_camera_input import jpeg_frame
from phone_usb_camera_fd_source import UsbCameraFdSource


def main():
    result = dict(status='failed', physicalUsb=True, androidTested=False, productEnabled=False,
                  decoded=True, mediaSaved=False, microphoneUsed=False, cases=[])
    server = socket.socket(socket.AF_UNIX)
    source = None
    received = []
    try:
        assert os.getuid() == 10001 and not list(Path('/dev').glob('video*'))
        server.bind('/handoff/input.sock')
        os.chmod('/handoff/input.sock', 0o600)
        server.listen(1)
        server.settimeout(20)
        for pixel in ('MJPG', 'YUYV'):
            with server.accept()[0] as peer:
                peer.settimeout(6)
                assert struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == 0
                marker, anc, flags, _ = peer.recvmsg(1, socket.CMSG_SPACE(4), socket.MSG_CMSG_CLOEXEC)
                assert marker == (b'M' if pixel == 'MJPG' else b'Y') and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
                for level, kind, data in anc:
                    assert level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS
                    values = array.array('i'); values.frombytes(data); received.extend(values)
                assert len(received) == 1
                rdev = os.fstat(received[0]).st_rdev
                allowed = threading.Event(); allowed.set()
                frames = []
                def deliver(frame, sequence, pts):
                    jpeg_frame(frame)
                    # Numbers only, never retain or hash private pixel content.
                    frames.append((sequence, pts, len(frame), time.monotonic()))
                source = UsbCameraFdSource(received[0], pixel_format=pixel, deliver=deliver, authorized=allowed.is_set)
                os.close(received.pop())
                peer.sendall(b'R')
                assert peer.recv(1) == b'S'
                at = time.monotonic()
                if pixel == 'MJPG':
                    allowed.clear()  # Revoke independently of the capture API.
                    assert source.done.wait(2)
                source.close()
                duration = time.monotonic() - at
                source = None
                count = len(frames)
                result['lastCapture'] = dict(format=pixel,frames=count,closeSeconds=round(duration,4))
                time.sleep(.1)
                assert len(frames) == count and count >= 35
                assert all(b[0] > a[0] and b[1] > a[1] for a, b in zip(frames, frames[1:]))
                remaining = 0
                for entry in Path('/proc/self/fd').iterdir():
                    try: remaining += entry.stat().st_rdev == rdev
                    except FileNotFoundError: pass
                assert remaining == 0
                value = dict(format=pixel, frames=count, maximumFrameBytes=max(f[2] for f in frames),
                    closeSeconds=round(duration, 4), remainingDeviceFds=remaining, decodedSize=[640, 480],
                    maxFrameGapSeconds=round(max(b[3]-a[3] for a, b in zip(frames, frames[1:])), 4),
                    observedFps=round((count-1)/(frames[-1][3]-frames[0][3]), 3),
                    stopKind='revoke' if pixel == 'MJPG' else 'explicit-stop')
                result['cases'].append(value)
                peer.sendall(json.dumps(value).encode()+b'\n')
        result.update(status='passed', noDeviceMount=True,
            memoryPeakBytes=int(Path('/sys/fs/cgroup/memory.peak').read_text()),
            memorySwapBytes=int(Path('/sys/fs/cgroup/memory.swap.current').read_text()))
    except BaseException as error:
        result['error'] = type(error).__name__ + ':' + str(error)[:160]
        result['errorLine'] = traceback.extract_tb(error.__traceback__)[-1].lineno
    finally:
        if source: source.close()
        for fd in received: os.close(fd)
        server.close()
        Path('/handoff/input.sock').unlink(missing_ok=True)
    print(json.dumps(result), flush=True)
    return int(result['status'] != 'passed')


if __name__ == '__main__': raise SystemExit(main())
