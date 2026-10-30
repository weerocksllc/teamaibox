#!/usr/bin/python3
"""Phone-private video-file handoff; one fixed supervised decoder, no TCP API.

Reuse the existing camera controller's bounded process termination and lease
watch. File data is passed as a sealed fd, never written to the phone disk.
"""
import array
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time

from phone_browser_camera_control import BrowserCameraControl, ReceiverProcess
from phone_camera_client import control
from phone_camera_input import CameraInput, CameraInputError, PrivateServer, receive
from phone_runtime import closed_json, validate_config
from phone_video_camera import sealed_input, VideoCameraError
from phone_video_camera_session import validate_start

SOCKET=Path('/tmp/phone-camera-input/video.sock')
WORKER='/opt/teamaibox/phone_video_camera_worker.py'


class VideoProcess(ReceiverProcess):
    worker = WORKER

    def __init__(self,value,fd):
        self._lock=threading.Lock()
        self.process=subprocess.Popen(['/usr/bin/python3','-B',self.worker,str(fd)],pass_fds=(fd,),
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        self.raw=(json.dumps(value,separators=(',',':'))+'\n').encode()

    def answer(self):
        # Tiny metadata only. The 64 MiB file is already inherited by fd.
        self.process.stdin.write(self.raw);self.process.stdin.close();self.raw=b''
        output=bytearray();deadline=time.monotonic()+8
        with selectors.DefaultSelector() as selected:
            os.set_blocking(self.process.stdout.fileno(),False)
            selected.register(self.process.stdout,selectors.EVENT_READ)
            while time.monotonic()<deadline:
                for key,_ in selected.select(.05):
                    data=os.read(key.fd,4096)
                    if not data:raise CameraInputError('phone_camera_runtime_unavailable')
                    output.extend(data)
                    if len(output)>4096:raise CameraInputError('phone_camera_runtime_unavailable')
                    if b'\n' in output:
                        if not output.endswith(b'\n') or output.count(b'\n')!=1:raise CameraInputError('phone_camera_runtime_unavailable')
                        value=closed_json(output)
                        if 'errorCode' in value:
                            code=value['errorCode']
                            raise CameraInputError(code if code in ('phone_camera_video_unsupported','phone_camera_source_stopped') else 'phone_camera_runtime_unavailable')
                        return value
        raise CameraInputError('phone_camera_runtime_unavailable')


class VideoCameraControl(BrowserCameraControl):
    source_kind = 'video'
    validate = staticmethod(validate_start)
    own_fd = staticmethod(sealed_input)

    def __init__(self,config,broker=control,factory=VideoProcess):
        super().__init__(config,broker,factory)

    def binding(self,grant):
        value=CameraInput.binding(type('Binding',(),{'config':self.config})(),grant)
        if value['sourceKind']!=self.source_kind:raise CameraInputError('phone_camera_source_unsupported')
        return value

    def start(self,value,fd):
        value=self.validate(value,self.config);grant=value['grant']
        try:owned=self.own_fd(fd)
        except VideoCameraError:raise CameraInputError('phone_camera_video_unsupported')
        try:
            with self.lock:
                if self.closed or self.active is not None:raise CameraInputError('phone_camera_source_stopped')
                if self.broker({'action':'status','grant':grant})['state']!='waiting':raise CameraInputError('phone_camera_source_stopped')
                active={'grant':grant,'process':self.factory(value,owned)};self.active=active
        finally:os.close(owned)
        try:
            result=active['process'].answer()
            with self.lock:
                if self.closed or self.active is not active or not active['process'].alive():raise CameraInputError('phone_camera_source_stopped')
                if result!={'sourceId':grant['sourceId'],'state':'receiving'} or self.broker({'action':'status','grant':grant})['state']!='receiving':
                    raise CameraInputError('phone_camera_source_stopped')
                return result
        except BaseException:
            with self.lock:
                if self.active is active:self._drop()
            raise

    def stop(self,grant):
        grant=self.binding(grant)
        with self.lock:
            state=self.broker({'action':'close','grant':grant})
            if self.active is not None and self.active['grant']==grant:self._drop()
            if state.get('sourceId')!=grant['sourceId'] or state.get('state')!='stopped':raise CameraInputError('phone_camera_runtime_unavailable')
            # No generic old-grant status: a replacement may already be active.
            return {'sourceId':grant['sourceId'],'state':'stopped','retainedFrameBytes':0}


def read_handoff(sock, marker=b'V'):
    fds=[]
    try:
        data,ancillary,flags,_=sock.recvmsg(1,socket.CMSG_SPACE(4*4),socket.MSG_CMSG_CLOEXEC)
        valid=data==marker and not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC)
        for level,kind,raw in ancillary:
            if level!=socket.SOL_SOCKET or kind!=socket.SCM_RIGHTS:
                valid=False;continue
            values=array.array('i');values.frombytes(raw[:len(raw)//values.itemsize*values.itemsize]);fds.extend(values)
        size=struct.unpack('!I',receive(sock,4))[0]
        if not valid or not 1<=size<=4096:raise CameraInputError('phone_camera_request_invalid')
        value=closed_json(receive(sock,size))
        if len(fds)!=(1 if value.get('action')=='start' else 0):raise CameraInputError('phone_camera_request_invalid')
        fd=fds.pop() if fds else None
        return value,fd
    finally:
        for fd in fds:os.close(fd)


def serve(config,path=SOCKET,manager_factory=VideoCameraControl,server_type=PrivateServer,marker=b'V',starter_uid=None):
    manager=manager_factory(config);stopped=threading.Event();slots=threading.BoundedSemaphore(3)
    class Server(socketserver.ThreadingMixIn,server_type):
        daemon_threads=True;block_on_close=False
        def process_request(self,request,address):
            if not slots.acquire(blocking=False):request.close();return
            try:super().process_request(request,address)
            except BaseException:slots.release();raise
        def process_request_thread(self,request,address):
            try:super().process_request_thread(request,address)
            finally:slots.release()
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            fd=None;self.request.settimeout(2)
            try:
                value,fd=read_handoff(self.request,marker);action=value.pop('action',None)
                if action=='start':
                    if starter_uid is not None and struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=starter_uid:
                        raise CameraInputError('phone_camera_usb_permission_required')
                    result=manager.start(value,fd)
                elif action=='close' and set(value)=={'grant'}:result=manager.stop(value['grant'])
                elif action=='status' and set(value)=={'grant'}:result=manager.status(value['grant'])
                else:raise CameraInputError('phone_camera_request_invalid')
                response={'result':result}
            except Exception as error:
                response={'error':str(error) if isinstance(error,CameraInputError) else 'phone_camera_runtime_unavailable'}
            finally:
                if fd is not None:os.close(fd)
            raw=json.dumps(response).encode();self.request.sendall(struct.pack('!I',len(raw))+raw)
    if path.exists() or path.is_symlink():raise CameraInputError('phone_camera_socket_occupied')
    server=Server(str(path),Handler);os.chmod(path,0o600)
    def watch():
        while not stopped.wait(.1):
            try:manager.check()
            except Exception:pass
    thread=threading.Thread(target=watch,daemon=True);thread.start()
    try:server.serve_forever(poll_interval=.1)
    finally:
        stopped.set();manager.close();server.server_close();thread.join(2)


if __name__=='__main__':
    info=SOCKET.parent.lstat()
    if os.getuid()!=10001 or not stat.S_ISDIR(info.st_mode) or info.st_uid!=10001 or stat.S_IMODE(info.st_mode)!=0o700:
        raise CameraInputError('phone_camera_directory_invalid')
    signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(SystemExit(0)))
    serve(validate_config(closed_json(Path('/run/phone/config.json').read_bytes())))
