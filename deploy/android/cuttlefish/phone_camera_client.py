#!/usr/bin/python3
"""Fixed Node Agent entry point into one phone's camera input.

No user-selected program/path, host device or TCP listener. Private input
objects use anonymous files on the encrypted phone volume and bounded decoding.
"""
import ctypes
import array
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import tempfile

from phone_camera_input import CameraInput, CameraInputError, jpeg_frame, receive, MAX_JPEG
from phone_runtime import closed_json, validate_config

MAX_IMAGE = 2**53 - 1
MAX_VIDEO = 2**53 - 1
END = b'\nTEAMAIBOX-CAMERA-END\n'
SOCKET = Path('/tmp/phone-camera-input/control.sock')
DECODER = '/opt/teamaibox/phone_camera_decode.py'


def request(value, config, now=None):
    now = time.time()*1000 if now is None else now
    action = value.get('action') if isinstance(value, dict) else None
    keys = {'action', 'grant', 'deadline'}
    if action in ('open', 'renew'):
        keys.add('leaseExpiresAt')
    if action == 'image':
        keys.update(('sizeBytes', 'sha256'))
    if action == 'video':
        keys.update(('sizeBytes', 'sha256', 'loop'))
    if action == 'browser-offer':
        keys.update(('sizeBytes', 'sha256', 'peerAddress'))
    if (action not in ('open', 'renew', 'image', 'video', 'browser-offer', 'close', 'status') or set(value) != keys
            or type(value['deadline']) is not int or not 0 < value['deadline']-now <= 15000):
        raise CameraInputError('phone_camera_request_invalid')
    grant = CameraInput.binding(type('Binding', (), {'config': config})(), value['grant'])
    if grant['sourceKind'] not in ('image','browser','video','usb','udp') or action in ('image','video') and grant['sourceKind']!=action or action=='browser-offer' and grant['sourceKind']!='browser':
        raise CameraInputError('phone_camera_source_unsupported')
    if action == 'video' and type(value['loop']) is not bool:
        raise CameraInputError('phone_camera_request_invalid')
    if action in ('open', 'renew'):
        expiry = value['leaseExpiresAt']
        if type(expiry) is not int or not 0 < expiry-now <= 5000:
            raise CameraInputError('phone_camera_lease_invalid')
    if action in ('image','video','browser-offer'):
        if type(value['sizeBytes']) is not int or not 0 < value['sizeBytes'] <= (MAX_VIDEO if action=='video' else MAX_IMAGE if action=='image' else 65536):
            raise CameraInputError('phone_camera_video_too_large' if action=='video' else 'phone_camera_image_too_large')
        digest = value['sha256']
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise CameraInputError('phone_camera_image_invalid')
    if action=='browser-offer':
        try:
            peer=ipaddress.IPv4Address(value['peerAddress'])
        except (ValueError,TypeError):
            raise CameraInputError('phone_camera_request_invalid')
        if not any(peer in ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')):
            raise CameraInputError('phone_camera_request_invalid')
    return dict(value)


def control(value, frame=None):
    directory = SOCKET.parent.lstat()
    info = SOCKET.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 10001 or stat.S_IMODE(directory.st_mode) != 0o700
            or not stat.S_ISSOCK(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o600):
        raise CameraInputError('phone_camera_runtime_unavailable')
    raw = json.dumps(value, separators=(',', ':')).encode()
    if len(raw) > 4096:
        raise CameraInputError('phone_camera_request_invalid')
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(1)
        sock.connect(str(SOCKET))
        _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 10001:
            raise CameraInputError('phone_camera_runtime_unavailable')
        sock.sendall(struct.pack('!I', len(raw))+raw)
        if frame is not None:
            sock.sendall(struct.pack('!I', len(frame))+frame)
        size = struct.unpack('!I', receive(sock, 4))[0]
        if not 1 <= size <= 4096:
            raise CameraInputError('phone_camera_runtime_unavailable')
        result = closed_json(receive(sock, size))
        if 'error' in result:
            raise CameraInputError('phone_camera_source_stopped')
        result = result.get('result')
        if not isinstance(result, dict) or result.get('sourceId') != value['grant']['sourceId']:
            raise CameraInputError('phone_camera_runtime_unavailable')
        return result


def decode(fd, deadline):
    parent = os.getpid()
    def parent_death():
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
            os._exit(1)
    child = subprocess.Popen(['/usr/bin/python3', '-B', DECODER], stdin=fd, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, preexec_fn=parent_death)
    output = bytearray()
    try:
        with selectors.DefaultSelector() as selected:
            os.set_blocking(child.stdout.fileno(), False)
            selected.register(child.stdout, selectors.EVENT_READ)
            while selected.get_map():
                if time.monotonic() >= deadline:
                    raise CameraInputError('phone_camera_image_timeout')
                for key, _ in selected.select(.1):
                    value = os.read(key.fileobj.fileno(), 65536)
                    if not value:
                        selected.unregister(key.fileobj)
                    else:
                        output.extend(value)
                        if len(output) > MAX_JPEG:
                            raise CameraInputError('phone_camera_frame_invalid')
        child.wait(timeout=max(.01, deadline-time.monotonic()))
        if child.returncode != 0:
            raise CameraInputError('phone_camera_image_unsupported')
        return jpeg_frame(bytes(output))
    finally:
        output[:] = b'\0' * len(output)
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
        child.stdout.close()


def browser_control(value):
    path=SOCKET.with_name('browser.sock')
    directory=path.parent.lstat();info=path.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid!=10001 or stat.S_IMODE(directory.st_mode)!=0o700
            or not stat.S_ISSOCK(info.st_mode) or info.st_uid!=10001 or stat.S_IMODE(info.st_mode)!=0o600):
        raise CameraInputError('phone_camera_runtime_unavailable')
    raw=json.dumps(value,separators=(',',':')).encode()
    if len(raw)>73728:raise CameraInputError('phone_camera_request_invalid')
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(11 if value['action']=='offer' else 2);sock.connect(str(path))
        _,uid,_=struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        if uid!=10001:raise CameraInputError('phone_camera_runtime_unavailable')
        sock.sendall(struct.pack('!I',len(raw))+raw)
        size=struct.unpack('!I',receive(sock,4))[0]
        if not 1<=size<=73728:raise CameraInputError('phone_camera_runtime_unavailable')
        result=closed_json(receive(sock,size))
        if 'error' in result:raise CameraInputError('phone_camera_source_stopped')
        result=result.get('result')
        if not isinstance(result,dict) or result.get('sourceId')!=value['grant']['sourceId']:
            raise CameraInputError('phone_camera_runtime_unavailable')
        return result


def video_control(value, fd=None, *, socket_name='video.sock', marker=b'V'):
    """Pass one read-only anonymous file to the same phone, not a host pathname."""
    if (socket_name,marker) not in (('video.sock',b'V'),('usb.sock',b'U'),('udp.sock',b'N')):
        raise CameraInputError('phone_camera_request_invalid')
    path = SOCKET.with_name(socket_name)
    directory, info = path.parent.lstat(), path.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 10001 or stat.S_IMODE(directory.st_mode) != 0o700
            or not stat.S_ISSOCK(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o600):
        raise CameraInputError('phone_camera_runtime_unavailable')
    raw = json.dumps(value,separators=(',',':')).encode()
    if len(raw)>4096 or (value.get('action')=='start') != (fd is not None):
        raise CameraInputError('phone_camera_request_invalid')
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(9 if fd is not None else 2)
        sock.connect(str(path))
        _,uid,_ = struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        if uid!=10001:raise CameraInputError('phone_camera_runtime_unavailable')
        rights=[] if fd is None else [(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))]
        # Ancillary data belongs to a single marker byte, independent of any
        # stream segmentation of the following bounded JSON frame.
        if sock.sendmsg([marker],rights)!=1:raise CameraInputError('phone_camera_runtime_unavailable')
        sock.sendall(struct.pack('!I',len(raw))+raw)
        size=struct.unpack('!I',receive(sock,4))[0]
        if not 1<=size<=4096:raise CameraInputError('phone_camera_runtime_unavailable')
        result=closed_json(receive(sock,size))
        if 'error' in result:
            code=result['error']
            raise CameraInputError(code if code in ('phone_camera_video_unsupported','phone_camera_source_stopped') else 'phone_camera_runtime_unavailable')
        result=result.get('result')
        if not isinstance(result,dict) or result.get('sourceId')!=value['grant']['sourceId']:
            raise CameraInputError('phone_camera_runtime_unavailable')
        return result


def usb_control(value):
    if value.get('action') not in ('close','status'):
        raise CameraInputError('phone_camera_usb_permission_required')
    return video_control(value,socket_name='usb.sock',marker=b'U')


def udp_control(value):
    if value.get('action') not in ('close','status'):
        raise CameraInputError('phone_camera_request_invalid')
    return video_control(value,socket_name='udp.sock',marker=b'N')


def execute(job, incoming, broker=control, convert=decode, browser_broker=browser_control, video_broker=video_control, progress=lambda:None, usb_broker=usb_control, udp_broker=udp_control):
    grant, action = job['grant'], job['action']
    packet = {'action': action, 'grant': grant}
    deadline = time.monotonic()+(job['deadline']-time.time()*1000)/1000
    if action in ('open', 'renew'):
        packet['leaseExpiresAt'] = job['leaseExpiresAt']
    answer=None
    if action=='browser-offer':
        raw=bytearray()
        try:
            while len(raw)<job['sizeBytes']:
                chunk=incoming.read(min(8192,job['sizeBytes']-len(raw)))
                if not chunk or time.monotonic()>=deadline:raise CameraInputError('phone_camera_request_expired')
                raw.extend(chunk)
            if incoming.read(len(END))!=END or incoming.read(1) or hashlib.sha256(raw).hexdigest()!=job['sha256']:
                raise CameraInputError('phone_camera_request_invalid')
            if broker({'action':'status','grant':grant})['state']!='waiting':raise CameraInputError('phone_camera_source_stopped')
            answer=browser_broker({'action':'offer','grant':grant,'allowedAddresses':[job['peerAddress']],'offerSdp':raw.decode('utf-8')})
            if set(answer)!={'sourceId','answerSdp','bindAddress'} or not isinstance(answer['answerSdp'],str) or not 1<=len(answer['answerSdp'].encode())<=65536:
                raise CameraInputError('phone_camera_runtime_unavailable')
            result=broker({'action':'status','grant':grant})
        except BaseException:
            try:browser_broker({'action':'close','grant':grant})
            except Exception:pass
            try:broker({'action':'close','grant':grant})
            except Exception:pass
            raise
        finally:
            raw[:]=b'\0'*len(raw)
    elif action not in ('image','video'):
        if incoming.read(1):
            raise CameraInputError('phone_camera_request_invalid')
        source_broker={'browser':browser_broker,'video':video_broker,'usb':usb_broker,'udp':udp_broker}.get(grant['sourceKind'])
        if source_broker and action=='close':
            # Clear the current frame even if the optional supervisor failed.
            broker(packet)
            result=source_broker(packet)
        else:
            if source_broker and action=='open':
                source_broker({'action':'status','grant':grant})
            result = broker(packet)
    else:
        # Use the existing encrypted phone volume, not a whole-file RAM buffer.
        # TemporaryFile unlinks immediately; termination closes the last fd.
        exchange = Path('/phone/exchange')
        capacity = os.statvfs(exchange)
        if job['sizeBytes'] > capacity.f_bavail * capacity.f_frsize:
            raise CameraInputError('phone_camera_storage_full')
        staging = tempfile.TemporaryFile(dir=exchange)
        fd = staging.fileno()
        readonly = None
        frame = None
        try:
            deadline = time.monotonic()+30
            progress()
            if broker({'action': 'status', 'grant': grant}).get('state') != 'waiting':
                raise CameraInputError('phone_camera_source_stopped')
            remaining, digest = job['sizeBytes'], hashlib.sha256()
            while remaining:
                if time.monotonic() >= deadline:
                    raise CameraInputError('phone_camera_image_timeout')
                chunk = incoming.read(min(65536, remaining))
                if not chunk:
                    raise CameraInputError('phone_camera_image_invalid')
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
                remaining -= len(chunk)
                deadline = time.monotonic()+30
                progress()
            if incoming.read(len(END)) != END or incoming.read(1) or digest.hexdigest() != job['sha256']:
                raise CameraInputError('phone_camera_image_invalid')
            os.lseek(fd, 0, os.SEEK_SET)
            readonly = os.open('/proc/self/fd/'+str(fd), os.O_RDONLY | os.O_CLOEXEC)
            staging.close()
            fd = readonly
            if action=='video':
                result=video_broker({'action':'start','grant':grant,'loop':job['loop']},fd)
                if result.get('state')!='receiving':raise CameraInputError('phone_camera_source_stopped')
            else:
                frame = convert(fd, min(deadline, time.monotonic()+5))
                result = broker({'action': 'frame', 'grant': grant, 'sequence': 1}, frame)
        except BaseException:
            if action=='video':
                try:video_broker({'action':'close','grant':grant})
                except Exception:pass
            try:
                broker({'action': 'close', 'grant': grant})
            except Exception:
                pass  # Independent five-second expiry still applies.
            raise
        finally:
            frame = None
            staging.close()
            if readonly is not None:
                os.close(readonly)
    if result.get('state') not in ('waiting', 'receiving', 'stopped'):
        raise CameraInputError('phone_camera_runtime_unavailable')
    reply = {**grant, 'state': result['state'], 'resourceScope': 'phone-run'}
    if action=='browser-offer':
        if result['state'] not in ('waiting','receiving'):raise CameraInputError('phone_camera_source_stopped')
        reply.update(answerSdp=answer['answerSdp'],containerAddress=answer['bindAddress'])
    if action in ('open', 'renew'):
        reply['leaseExpiresAt'] = job['leaseExpiresAt']
    if action == 'close':
        stopped = broker({'action': 'status', 'grant': grant})
        if stopped.get('state') != 'stopped' or stopped.get('retainedFrameBytes') != 0:
            raise CameraInputError('phone_camera_runtime_unavailable')
        reply['retainedFrameBytes'] = 0
    return reply


def main():
    def interrupt(*_):
        raise CameraInputError('phone_camera_request_expired')
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.setitimer(signal.ITIMER_REAL, 3)
    try:
        if os.getuid() != 10001:
            raise CameraInputError('phone_camera_uid_invalid')
        config = validate_config(closed_json(Path('/run/phone/config.json').read_bytes()))
        raw = sys.stdin.buffer.readline(4097)
        if len(raw) > 4096 or not raw.endswith(b'\n'):
            raise CameraInputError('phone_camera_request_invalid')
        job = request(closed_json(raw), config)
        transfer=job['action'] in ('image','video')
        signal.setitimer(signal.ITIMER_REAL, 30 if transfer else max(.001, (job['deadline']-time.time()*1000)/1000))
        print(json.dumps(execute(job, sys.stdin.buffer,
            progress=(lambda:signal.setitimer(signal.ITIMER_REAL,30)) if transfer else (lambda:None))), flush=True)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, CameraInputError) else 'phone_camera_runtime_unavailable'
        print(json.dumps({'errorCode': code}), flush=True)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    raise SystemExit(main())
