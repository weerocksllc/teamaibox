"""One run's bounded camera input. Private Unix sockets, no network/recording.

Node Agent supplies an already-authorized owner/run/source lease. Camera2 reads
the current frame on demand; no historical frame queue survives revocation.
All source acquisition/decoding and public API authorization are outside here.
"""
import json
import math
import os
from pathlib import Path
import re
import socket
import socketserver
import stat
import struct
import threading
import time

WIDTH, HEIGHT, MAX_JPEG = 640, 480, 640*480*2
BINDING = {'id','sourceId','sourceKind','phoneId','ownerId','runId','generation','sessionId'}
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
SOURCE_KINDS = {'image','browser','usb','video','udp'}


class CameraInputError(RuntimeError):
    pass


def jpeg_frame(value):
    """Accept only a bounded, baseline 640x480 JPEG from trusted conversion.

This header check is not a decoder. Source decoders remain resource limited;
actual Android decoding and malformed-source handling need integration tests.
"""
    if not isinstance(value,bytes) or not 4<len(value)<=MAX_JPEG or value[:2]!=b'\xff\xd8' or value[-2:]!=b'\xff\xd9':
        raise CameraInputError('phone_camera_frame_invalid')
    offset=2;dimensions=False
    while offset+4<=len(value):
        if value[offset]!=255:break
        marker=value[offset+1];offset+=2
        if marker in (0,255,216,217) or 208<=marker<=215:break
        length=int.from_bytes(value[offset:offset+2],'big')
        if length<2 or offset+length>len(value):break
        if marker==0xc0:
            if length!=17 or dimensions or value[offset+2]!=8 or value[offset+7]!=3:
                break
            height=int.from_bytes(value[offset+3:offset+5],'big');width=int.from_bytes(value[offset+5:offset+7],'big')
            if (width,height)!=(WIDTH,HEIGHT):break
            dimensions=True
        elif marker in (0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
            break
        elif marker==0xda:
            if dimensions:return value
            break
        offset+=length
    raise CameraInputError('phone_camera_frame_format_unsupported')


class CameraInput:
    def __init__(self,config,neutral,clock=time.monotonic,wall=time.time):
        self.config=config;self.neutral=jpeg_frame(neutral);self.clock=clock;self.wall=wall
        self.lock=threading.Lock();self.active=None;self.revoked=set();self.delivered=0

    def binding(self,grant):
        if not isinstance(grant,dict) or set(grant)!=BINDING:
            raise CameraInputError('phone_camera_binding_invalid')
        if (any(not isinstance(grant[k],str) or not re.fullmatch(UUID,grant[k]) for k in BINDING-{'sourceKind','generation'}) or
            type(grant['generation']) is not int or not isinstance(grant['sourceKind'],str) or grant['sourceKind'] not in SOURCE_KINDS):
            raise CameraInputError('phone_camera_binding_invalid')
        if any(grant[k]!=self.config[k] for k in ('phoneId','ownerId','runId','generation')):
            raise CameraInputError('phone_camera_stale_run')
        return dict(grant)

    def deadline(self,expiry):
        if type(expiry) not in (int,float) or not math.isfinite(expiry):
            raise CameraInputError('phone_camera_lease_invalid')
        remaining=expiry/1000-self.wall()
        if not 0<remaining<=5:raise CameraInputError('phone_camera_lease_invalid')
        return self.clock()+remaining

    def _clear(self):
        if self.active:
            self.revoked.add(self.active['grant']['id']);self.active=None

    def _expire(self):
        if self.active and self.clock()>=self.active['deadline']:self._clear()
        elif self.active and self.active['grant']['sourceKind']!='image' and self.active['frameAt'] is not None and self.clock()-self.active['frameAt']>1:
            self.active['frame']=None

    def expire(self):
        with self.lock:self._expire()

    def watch(self,stopped):
        # Reclaim private frames even when Camera2 and the control client are idle.
        while not stopped.wait(.1):self.expire()

    def apply(self,request,frame=None):
        if not isinstance(request,dict) or request.get('action') not in ('open','renew','frame','close','status'):
            raise CameraInputError('phone_camera_request_invalid')
        action=request['action'];keys={'action','grant'}
        if action in ('open','renew'):keys.add('leaseExpiresAt')
        if action=='frame':keys.add('sequence')
        if set(request)!=keys or (action!='frame' and frame is not None):
            raise CameraInputError('phone_camera_request_invalid')
        grant=self.binding(request['grant'])
        deadline=self.deadline(request['leaseExpiresAt']) if action in ('open','renew') else None
        if action=='frame':
            if type(request['sequence']) is not int or not 0<=request['sequence']<2**53:
                raise CameraInputError('phone_camera_sequence_invalid')
            jpeg_frame(frame)
        with self.lock:
            self._expire()
            if action=='status':
                if self.active and self.active['grant']!=grant:raise CameraInputError('phone_camera_source_inactive')
                return dict(state=('receiving' if self.active['frame'] is not None else 'waiting') if self.active else 'stopped',
                            sourceId=grant['sourceId'],framesDelivered=self.delivered,
                            retainedFrameBytes=len(self.active['frame']) if self.active and self.active['frame'] else 0)
            if action=='close':
                if self.active and self.active['grant']['id']==grant['id'] and self.active['grant']!=grant:
                    raise CameraInputError('phone_camera_binding_invalid')
                if grant['id'] not in self.revoked and len(self.revoked)>=4096:
                    self._clear();raise CameraInputError('phone_camera_run_limit')
                if self.active and self.active['grant']==grant:self._clear()
                self.revoked.add(grant['id'])
                return dict(state='stopped',sourceId=grant['sourceId'])
            if grant['id'] in self.revoked:raise CameraInputError('phone_camera_lease_revoked')
            if action=='open':
                if len(self.revoked)>=4096:raise CameraInputError('phone_camera_run_limit')
                if self.active and self.active['grant']!=grant:
                    if self.active['grant']['id']==grant['id']:raise CameraInputError('phone_camera_binding_invalid')
                    self._clear()
                if not self.active:self.active=dict(grant=grant,deadline=deadline,frame=None,sequence=-1,frameAt=None)
                else:self.active['deadline']=deadline
            else:
                if not self.active or self.active['grant']!=grant:raise CameraInputError('phone_camera_source_inactive')
                if action=='renew':self.active['deadline']=deadline
                else:
                    if request['sequence']<=self.active['sequence']:raise CameraInputError('phone_camera_sequence_stale')
                    self.active.update(frame=frame,sequence=request['sequence'],frameAt=self.clock())
            return dict(state='receiving' if self.active['frame'] is not None else 'waiting',sourceId=grant['sourceId'])

    def current(self):
        with self.lock:
            self._expire();self.delivered+=1
            # A video/browser/USB/UDP producer must keep sending fresh frames.
            # A user's still image is held only for its actively renewed lease.
            if self.active and self.active['frame'] is not None:
                if self.active['grant']['sourceKind']=='image' or self.clock()-self.active['frameAt']<=1:
                    return self.active['frame']
                self.active['frame']=None
            return self.neutral


def receive(sock,count):
    blocks=[]
    while count:
        block=sock.recv(count)
        if not block:raise EOFError()
        blocks.append(block);count-=len(block)
    return b''.join(blocks)


class PrivateServer(socketserver.UnixStreamServer):
    allow_reuse_address=False
    def verify_request(self,request,address):
        _,uid,_=struct.unpack('3i',request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        return uid==10001
    def handle_error(self,request,address):
        # No request/frame content or exception traceback is logged.
        pass


def serve(config,neutral,directory):
    state=CameraInput(config,neutral)
    class Frames(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(.5)
            while self.request.recv(1)==b'F':
                value=state.current();self.request.sendall(struct.pack('!I',len(value))+value)
    class Control(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(1)
            try:
                size=struct.unpack('!I',receive(self.request,4))[0]
                if not 1<=size<=4096:raise CameraInputError('phone_camera_request_invalid')
                request=json.loads(receive(self.request,size));frame=None
                if isinstance(request,dict) and request.get('action')=='frame':
                    size=struct.unpack('!I',receive(self.request,4))[0]
                    if not 4<size<=MAX_JPEG:raise CameraInputError('phone_camera_frame_invalid')
                    frame=receive(self.request,size)
                result={'result':state.apply(request,frame)}
            except (CameraInputError,ValueError,EOFError,TimeoutError,OSError) as error:
                result={'error':str(error) if isinstance(error,CameraInputError) else 'phone_camera_request_invalid'}
            data=json.dumps(result).encode();self.request.sendall(struct.pack('!I',len(data))+data)
    servers=[];stopped=threading.Event()
    try:
        for name,handler in (('frames.sock',Frames),('control.sock',Control)):
            path=directory/name
            if path.exists() or path.is_symlink():raise CameraInputError('phone_camera_socket_occupied')
            server=PrivateServer(str(path),handler);os.chmod(path,0o600);servers.append(server)
        thread=threading.Thread(target=servers[0].serve_forever,daemon=True);thread.start()
        threading.Thread(target=state.watch,args=(stopped,),daemon=True).start()
        servers[1].serve_forever()
    finally:
        stopped.set()
        for server in servers:server.server_close()


def main():
    if os.getuid()!=10001:raise CameraInputError('phone_camera_uid_invalid')
    config=json.loads(Path('/run/phone/config.json').read_bytes())
    directory=Path('/tmp/phone-camera-input');info=directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=10001 or stat.S_IMODE(info.st_mode)!=0o700:
        raise CameraInputError('phone_camera_directory_invalid')
    serve(config,Path('/opt/teamaibox/camera-neutral.jpg').read_bytes(),directory)


if __name__=='__main__':main()
