"""Node-side UDP descriptor handoff for a signed, owner-bound camera request.

No decoder or forwarding loop runs on the host. The fixed phone process owns
the bound socket after handoff; closing its camera lease releases the port.
The caller is the existing local Node Agent helper, not an HTTP endpoint.
"""
import array
import os
from pathlib import Path
import re
import select
import socket
import stat
import struct
import time
import json

from phone_udp_ingress import UdpPolicy,UdpIngressError
from phone_usb_camera_devices import identifier
from phone_usb_host_control import inspect_container,validate_container,closed_json,receive


def fail(code):raise UdpIngressError('phone_camera_udp_'+code)


def validate_request(value,now=None):
    now=time.time()*1000 if now is None else now
    if not isinstance(value,dict) or set(value)!={'action','nodeId','deadline','containerId','grant','policy'} or value['action']!='udp-start':fail('request_invalid')
    identifier(value['nodeId'])
    if type(value['deadline']) is not int or not 0<value['deadline']-now<=15000:fail('request_expired')
    if not isinstance(value['containerId'],str) or not re.fullmatch('[0-9a-f]{64}',value['containerId']):fail('request_invalid')
    g=value['grant']
    if not isinstance(g,dict) or set(g)!={'id','sourceId','sourceKind','phoneId','ownerId','runId','generation','sessionId'}:fail('request_invalid')
    for k in ('id','sourceId','phoneId','ownerId','runId','sessionId'):identifier(g[k])
    if g['sourceKind']!='udp' or type(g['generation']) is not int or not 1<=g['generation']<2**53:fail('request_invalid')
    UdpPolicy.from_admin(value['policy'])
    return value


def bind_socket(policy):
    incoming=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    try:
        # No REUSEADDR/REUSEPORT: two phones cannot receive each other's input.
        incoming.set_inheritable(False);incoming.bind((policy.address,policy.port))
        return incoming
    except OSError:
        incoming.close();fail('port_unavailable')


def handoff(value,*,inspect=inspect_container):
    request=validate_request(value);policy=UdpPolicy.from_admin(request['policy'])
    pid=validate_container(inspect(request['containerId']),request);pidfd=os.pidfd_open(pid,0);rootfd=None
    try:
        if select.select([pidfd],[],[],0)[0]:fail('stale_run')
        rootfd=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        root='/proc/self/fd/'+str(rootfd)
        config=closed_json(Path(root+'/run/phone/config.json').read_bytes())
        if any(config.get(k)!=request['grant'][k] for k in ('phoneId','ownerId','runId','generation')):fail('stale_run')
        path=Path(root+'/tmp/phone-camera-input/udp.sock');parent=path.parent.lstat();endpoint=path.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=10001 or stat.S_IMODE(parent.st_mode)!=0o700
                or not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid!=10001 or stat.S_IMODE(endpoint.st_mode)!=0o600):fail('runtime_unavailable')
        if validate_container(inspect(request['containerId']),request)!=pid or select.select([pidfd],[],[],0)[0]:fail('stale_run')
        if request['deadline']<=time.time()*1000:fail('request_expired')
        raw=json.dumps(dict(action='start',grant=request['grant'],policy=request['policy']),separators=(',',':')).encode()
        with bind_socket(policy) as incoming,socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(min(8,(request['deadline']-time.time()*1000)/1000));peer.connect(str(path))
            if struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=10001:fail('runtime_unavailable')
            if peer.sendmsg([b'N'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[incoming.fileno()]))])!=1:fail('runtime_unavailable')
            peer.sendall(struct.pack('!I',len(raw))+raw)
            size=struct.unpack('!I',receive(peer,4))[0]
            if not 0<size<=4096:fail('runtime_unavailable')
            result=closed_json(receive(peer,size)).get('result',{})
            if set(result)!={'sourceId','state'} or result['sourceId']!=request['grant']['sourceId'] or result['state'] not in ('waiting','receiving'):fail('capture_failed')
        return {**request['grant'],'state':result['state'],'resourceScope':'phone-run'}
    finally:
        if rootfd is not None:os.close(rootfd)
        os.close(pidfd)
