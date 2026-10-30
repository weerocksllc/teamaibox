#!/usr/bin/python3
"""Node-local camera opener: metadata and a descriptor, never video processing.

Installed beside the existing host storage helper. Only the Node Agent mounts
its private socket. No TCP port, shell command, device path or destination path
is accepted. Frame conversion runs inside the selected phone's own budget.
"""
import argparse
import array
import http.client
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import socketserver
import stat
import struct
import threading
import time
import traceback

from phone_usb_camera_devices import inventory, identifier, UsbCameraError


def fail(code):
    raise UsbCameraError('phone_camera_usb_'+code)


def closed_json(raw):
    def pairs(items):
        result={}
        for k,v in items:
            if k in result:fail('request_invalid')
            result[k]=v
        return result
    try:return json.loads(raw,object_pairs_hook=pairs)
    except (ValueError,UnicodeError):fail('request_invalid')


def validate_request(value,now=None):
    now=time.time()*1000 if now is None else now
    if not isinstance(value,dict):fail('request_invalid')
    action=value.get('action')
    fields={'action','nodeId','deadline'}
    if action=='start':fields|={'containerId','grant','deviceId','attachmentId'}
    if action not in ('inventory','start') or set(value)!=fields:fail('request_invalid')
    identifier(value['nodeId'])
    if type(value['deadline']) is not int or not 0<value['deadline']-now<=15000:fail('request_expired')
    if action=='start':
        if not isinstance(value['containerId'],str) or not re.fullmatch('[0-9a-f]{64}',value['containerId']):fail('request_invalid')
        identifier(value['deviceId'])
        if not isinstance(value['attachmentId'],str) or not re.fullmatch('[0-9a-f]{64}',value['attachmentId']):fail('request_invalid')
        g=value['grant']
        if not isinstance(g,dict) or set(g)!={'id','sourceId','sourceKind','phoneId','ownerId','runId','generation','sessionId'}:fail('request_invalid')
        for k in ('id','sourceId','phoneId','ownerId','runId','sessionId'):identifier(g[k])
        if g['sourceKind']!='usb' or type(g['generation']) is not int or not 1<=g['generation']<2**53:fail('request_invalid')
    return value


def validate_container(value,request):
    g=request['grant'];labels=value.get('Config',{}).get('Labels') or {}
    expected={'managed':'true','kind':'android-phone','node-id':request['nodeId'],
              'phone-id':g['phoneId'],'owner-identity-id':g['ownerId'],
              'phone-run-id':g['runId'],'phone-generation':str(g['generation'])}
    if (value.get('Id')!=request['containerId'] or value.get('Name')!='/teamaibox-phone-'+g['runId']
        or any(labels.get('com.teamaibox.'+k)!=v for k,v in expected.items())):fail('stale_run')
    state=value.get('State',{});host=value.get('HostConfig',{})
    if (state.get('Running') is not True or type(state.get('Pid')) is not int or state['Pid']<2
        or host.get('Privileged') is not False or host.get('PidMode') not in ('',None)):
        fail('phone_not_running')
    return state['Pid']


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def inspect_container(cid):
    # cid has already been parsed as exactly 64 lower-case hex characters.
    connection=DockerConnection('localhost',timeout=2)
    try:
        connection.request('GET','/containers/'+cid+'/json')
        response=connection.getresponse();raw=response.read(1024*1024+1)
        if response.status!=200 or len(raw)>1024*1024:fail('stale_run')
        return closed_json(raw)
    finally:connection.close()


def receive(peer,size):
    chunks=bytearray()
    while len(chunks)<size:
        part=peer.recv(size-len(chunks))
        if not part:fail('runtime_unavailable')
        chunks.extend(part)
    return bytes(chunks)


def device_free(path,proc=Path('/proc')):
    # Check open device descriptors directly. fuser also probes network sockets
    # even for a video device, which fails in this AF_UNIX-only service.
    if not re.fullmatch(r'/dev/video[0-9]+',path):fail('device_invalid')
    target=os.stat(path);deadline=time.monotonic()+2
    if not stat.S_ISCHR(target.st_mode):fail('device_invalid')
    try:
        for process in proc.iterdir():
            if not process.name.isdecimal():continue
            try:
                for fd in (process/'fd').iterdir():
                    if time.monotonic()>deadline:fail('device_check_failed')
                    try:opened=fd.stat()
                    except FileNotFoundError:continue
                    if stat.S_ISCHR(opened.st_mode) and opened.st_rdev==target.st_rdev:return False
            except (FileNotFoundError,ProcessLookupError):continue
        return True
    except OSError:fail('device_check_failed')


def handoff(request,device,*,inspect=inspect_container,busy_check=device_free,discover=inventory):
    """Open only a freshly discovered camera and give it to the exact live run."""
    pid=validate_container(inspect(request['containerId']),request)
    pidfd=os.pidfd_open(pid,0)
    rootfd=None;devicefd=None
    try:
        if select.select([pidfd],[],[],0)[0]:fail('stale_run')
        rootfd=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        root='/proc/self/fd/'+str(rootfd)
        config=closed_json(Path(root+'/run/phone/config.json').read_bytes())
        if any(config.get(k)!=request['grant'][k] for k in ('phoneId','ownerId','runId','generation')):fail('stale_run')
        path=Path(root+'/tmp/phone-camera-input/usb.sock')
        parent=path.parent.lstat();endpoint=path.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=10001 or stat.S_IMODE(parent.st_mode)!=0o700
            or not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid!=10001 or stat.S_IMODE(endpoint.st_mode)!=0o600):fail('runtime_unavailable')
        before=os.lstat(device.device_path)
        if (not stat.S_ISCHR(before.st_mode) or before.st_rdev!=device.rdev
            or not busy_check(device.device_path)):fail('device_busy')
        devicefd=os.open(device.device_path,os.O_RDWR|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
        opened=os.fstat(devicefd)
        if (opened.st_ino,opened.st_rdev)!=(before.st_ino,device.rdev):fail('device_changed')
        live,issues=discover(request['nodeId'])
        if issues or [d for d in live if d.device_id==device.device_id]!=[device]:fail('device_changed')
        if validate_container(inspect(request['containerId']),request)!=pid or select.select([pidfd],[],[],0)[0]:fail('stale_run')
        if request['deadline']<=time.time()*1000:fail('request_expired')
        # Prefer the compressed mode when available, never invent a mode.
        pixel=next((p for p in ('MJPG','YUYV') if p in device.formats),None)
        if pixel is None:fail('format_unsupported')
        raw=json.dumps(dict(action='start',grant=request['grant'],pixelFormat=pixel),separators=(',',':')).encode()
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(min(8,(request['deadline']-time.time()*1000)/1000));peer.connect(str(path))
            if struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=10001:fail('runtime_unavailable')
            if peer.sendmsg([b'U'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[devicefd]))])!=1:fail('runtime_unavailable')
            os.close(devicefd);devicefd=None
            peer.sendall(struct.pack('!I',len(raw))+raw)
            size=struct.unpack('!I',receive(peer,4))[0]
            if not 0<size<=4096:fail('runtime_unavailable')
            result=closed_json(receive(peer,size))
            if result.get('result')!={'sourceId':request['grant']['sourceId'],'state':'receiving'}:fail('capture_failed')
        return {**request['grant'],'state':'receiving','resourceScope':'phone-run'}
    finally:
        if devicefd is not None:os.close(devicefd)
        if rootfd is not None:os.close(rootfd)
        os.close(pidfd)


class Control:
    def __init__(self,node_id,*,discover=inventory,start=handoff):
        self.node_id=identifier(node_id);self.discover=discover;self.start=start
        self.lock=threading.Lock()

    def handle(self,value):
        if isinstance(value,dict) and value.get('action')=='udp-start':
            # Lazy import preserves the USB-only helper on older installations.
            from phone_udp_host_control import validate_request as udp_request,handoff as udp_handoff
            request=udp_request(value)
            if request['nodeId']!=self.node_id:fail('wrong_node')
            with self.lock:return udp_handoff(request)
        request=validate_request(value)
        if request['nodeId']!=self.node_id:fail('wrong_node')
        # Only serialize discovery/open, not the lifetime of a video stream.
        with self.lock:
            devices,issues=self.discover(self.node_id)
            if issues:fail('inventory_unavailable')
            if request['action']=='inventory':
                return dict(nodeId=self.node_id,data=[d.public() for d in devices if set(d.formats)&{'MJPG','YUYV'}])
            selected=[d for d in devices if d.device_id==request['deviceId'] and d.attachment_id==request['attachmentId']]
            if len(selected)!=1:fail('device_changed')
            return self.start(request,selected[0])


def serve(path,node_id,client_uid):
    info=path.parent.lstat()
    if (os.getuid()!=0 or not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o007
        or path.name!='camera.sock' or path.exists() or path.is_symlink()):fail('socket_invalid')
    control=Control(node_id)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            if struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=client_uid:return
            self.request.settimeout(15)
            try:
                raw=self.rfile.readline(8193)
                if len(raw)>8192 or not raw.endswith(b'\n'):fail('request_invalid')
                result={'result':control.handle(closed_json(raw))}
            except Exception as error:
                # Keep private paths/request contents out of the response.
                code=str(error) if isinstance(error,UsbCameraError) else 'phone_camera_usb_runtime_unavailable'
                if type(error).__name__=='UdpIngressError' and str(error) in ('phone_camera_udp_port_unavailable','phone_camera_udp_request_expired','phone_camera_udp_stale_run','phone_camera_udp_runtime_unavailable','phone_camera_udp_capture_failed'):
                    code=str(error)
                result={'error':code}
                # Metadata only: never dump the request, grant, image or a
                # device pathname. This keeps failures actionable on the node.
                frames=traceback.extract_tb(error.__traceback__)
                print(json.dumps(dict(event='usb_control_failed',code=result['error'],
                    exception=type(error).__name__,locations=[dict(file=Path(f.filename).name,line=f.lineno) for f in frames])),flush=True)
            self.wfile.write(json.dumps(result,separators=(',',':')).encode()+b'\n')
    # Requests are short local controls; no private frame passes this socket.
    with socketserver.UnixStreamServer(str(path),Handler) as server:
        os.chown(path,0,client_uid);os.chmod(path,0o660)
        try:server.serve_forever(poll_interval=.2)
        finally:path.unlink(missing_ok=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);parser.add_argument('--socket',type=Path,required=True)
    args=parser.parse_args();info=args.config.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>4096:fail('configuration_invalid')
    conf=closed_json(args.config.read_bytes())
    if set(conf)!={'nodeId','clientUid'} or type(conf['clientUid']) is not int or conf['clientUid']<1:fail('configuration_invalid')
    signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(SystemExit(0)))
    serve(args.socket,conf['nodeId'],conf['clientUid'])
