#!/usr/bin/env python3
"""Root-owned HDMI greeter lease. Only local IPC and kernel hotplug notices.

The socket is exposed only to the trusted media container. Each lease is held
by a connection: EOF, deadline or helper shutdown restores the stopped greeter.
Active local user desktops are never eligible for takeover.
"""
import json
import ctypes
import errno
import os
from pathlib import Path
import re
import select
import signal
import socket
import socketserver
import struct
import subprocess
import threading
import time

ROOT=Path('/run/teamaibox/display-lease')
MARKER=ROOT/'restore-needed'
LOCK=threading.Lock()
STOP=threading.Event()
OWNER=None
CONNECTOR=Path('/sys/class/drm/card1-HDMI-A-1')
DETECTION_VALID=False

def run(*args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=12)
    if p.returncode!=0: raise RuntimeError('display_operation_failed')
    return p.stdout.strip()

def eligible():
    if run('systemctl','show','display-manager','-p','Id','--value')!='gdm.service': return False
    if run('systemctl','show','gdm.service','-p','ActiveState','--value') not in ('active','inactive'): return False
    seats=run('loginctl','list-seats','--no-legend','--no-pager').splitlines()
    for row in seats:
        seat=row.split()[0]
        if not re.fullmatch(r'seat[A-Za-z0-9_-]+',seat): return False
        for sid in run('loginctl','show-seat',seat,'-p','Sessions','--value').split():
            if not re.fullmatch(r'[A-Za-z0-9]+',sid): return False
            props=dict(line.split('=',1) for line in run('loginctl','show-session',sid,'-p','Class','-p','Remote').splitlines())
            if props.get('Class')!='greeter' or props.get('Remote')!='no': return False
    return True

def refresh_connector_status():
    """Kernel connector reprobe: startup/hotplug only, never a status poll.

    No X server, authentication cookie, mode change or caller-selected path.
    systemd permits writes only to this fixed connector's status attribute.
    """
    global DETECTION_VALID
    DETECTION_VALID=False
    try:
        if OWNER is None and not eligible():return False
        (CONNECTOR/'status').write_text('detect\n')
        DETECTION_VALID=True
        return True
    except (OSError,RuntimeError,subprocess.SubprocessError):return False

def kernel_hotplug(data,peer,card_path):
    if not peer or peer[0]!=0 or len(data)>4096:return False
    try:
        fields=dict(x.split('=',1) for x in data.decode('ascii').split('\0') if '=' in x)
    except (ValueError,UnicodeError):return False
    return (fields.get('SUBSYSTEM')=='drm' and fields.get('ACTION')=='change'
            and fields.get('HOTPLUG')=='1'
            and fields.get('DEVPATH') in (card_path,card_path+'/card1-HDMI-A-1'))

class EldHotplugMonitor:
    """Read-only HDMI connector notifications from the fixed audio device.

    NVIDIA's display server may update HDMI/ELD without a DRM uevent. Watch
    the kernel's PCM 3 ELD / jack events too; never read PCM, EDID, labels or
    mixer values, and never write audio controls. No extra host package.
    """
    def __init__(self):
        self.lib=ctypes.CDLL('libasound.so.2');self.handle=ctypes.c_void_p();self.event=ctypes.c_void_p()
        signatures={
            'snd_ctl_open':([ctypes.POINTER(ctypes.c_void_p),ctypes.c_char_p,ctypes.c_int],ctypes.c_int),
            'snd_ctl_close':([ctypes.c_void_p],ctypes.c_int),
            'snd_ctl_subscribe_events':([ctypes.c_void_p,ctypes.c_int],ctypes.c_int),
            'snd_ctl_event_malloc':([ctypes.POINTER(ctypes.c_void_p)],ctypes.c_int),
            'snd_ctl_event_free':([ctypes.c_void_p],None),
            'snd_ctl_read':([ctypes.c_void_p,ctypes.c_void_p],ctypes.c_int),
            'snd_ctl_event_get_type':([ctypes.c_void_p],ctypes.c_int),
            'snd_ctl_event_elem_get_name':([ctypes.c_void_p],ctypes.c_char_p),
            'snd_ctl_event_elem_get_device':([ctypes.c_void_p],ctypes.c_uint),
        }
        for name,(args,result) in signatures.items():
            f=getattr(self.lib,name);f.argtypes=args;f.restype=result
        try:
            # ALSA SND_CTL_READONLY (4) | SND_CTL_NONBLOCK (1).
            if self.lib.snd_ctl_open(ctypes.byref(self.handle),b'hw:0',5)<0:raise RuntimeError('eld_monitor_unavailable')
            if self.lib.snd_ctl_event_malloc(ctypes.byref(self.event))<0 or self.lib.snd_ctl_subscribe_events(self.handle,1)<0:raise RuntimeError('eld_monitor_unavailable')
        except Exception:self.close();raise
    def changed(self):
        found=False
        for _ in range(32):
            result=self.lib.snd_ctl_read(self.handle,self.event)
            if result in (-errno.EAGAIN,-errno.EINTR,0):break
            if result<0:raise RuntimeError('eld_monitor_unavailable')
            if self.lib.snd_ctl_event_get_type(self.event)!=0:continue
            name=self.lib.snd_ctl_event_elem_get_name(self.event)
            if name==b'HDMI/DP,pcm=3 Jack' or (name==b'ELD' and self.lib.snd_ctl_event_elem_get_device(self.event)==3):found=True
        return found
    def close(self):
        if self.event:self.lib.snd_ctl_event_free(self.event);self.event=ctypes.c_void_p()
        if self.handle:self.lib.snd_ctl_close(self.handle);self.handle=ctypes.c_void_p()

class HotplugMonitor:
    """Kernel-only DRM notices, coalesced without periodically forcing probes."""
    def __init__(self):
        self.card_path=str(CONNECTOR.resolve().parent).removeprefix('/sys')
        self.channel=socket.socket(socket.AF_NETLINK,socket.SOCK_DGRAM,15)
        self.channel.bind((0,1));self.channel.setblocking(False)
        self.pending=None
        try:self.audio=EldHotplugMonitor()
        except Exception:self.channel.close();raise
    def poll(self):
        now=time.monotonic()
        if self.audio.changed() and self.pending is None:self.pending=now+.25
        for _ in range(32):
            try:data,peer=self.channel.recvfrom(4097)
            except BlockingIOError:break
            if kernel_hotplug(data,peer,self.card_path) and self.pending is None:
                self.pending=now+.25
        if self.pending is not None and now>=self.pending:
            self.pending=None
            with LOCK:refresh_connector_status()
    def close(self):
        self.channel.close();self.audio.close()

def connected():
    if not DETECTION_VALID:return False
    try:
        return ((CONNECTOR/'status').read_text().strip()=='connected'
                and '1920x1080' in (CONNECTOR/'modes').read_text().splitlines())
    except OSError:return False

def restore():
    if MARKER.exists():
        run('systemctl','start','gdm.service')
        MARKER.unlink()

def valid_request(value):
    if value=={'operation':'status'}: return True
    return (type(value) is dict and set(value)=={'operation','sessionId','expiresAt'}
        and value['operation']=='acquire' and isinstance(value['sessionId'],str)
        and re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}',value['sessionId']) is not None
        and type(value['expiresAt']) in (int,float) and time.time()<value['expiresAt']<=time.time()+14400)

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        global OWNER
        held=False
        try:
            uid=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
            if uid!=65532: return
            self.request.settimeout(3)
            data=bytearray()
            while len(data)<512 and not data.endswith(b'\n'):
                part=self.request.recv(1)
                if not part: return
                data.extend(part)
            value=json.loads(data)
            if not valid_request(value): return
            with LOCK:
                ready=not STOP.is_set() and (OWNER is not None if value['operation']=='status' else False)
                if OWNER is None: ready=not STOP.is_set() and not MARKER.exists() and eligible()
                reason=None if ready else 'cast_hdmi_display_busy'
                if ready and not connected():
                    ready=False;reason='cast_hdmi_disconnected_or_unsupported'
                if value['operation']=='acquire' and ready and OWNER is None:
                    if run('systemctl','show','gdm.service','-p','ActiveState','--value')=='active':
                        # Persist only a restore flag in tmpfs before stopping.
                        MARKER.touch(mode=0o600,exist_ok=False)
                        try: run('systemctl','stop','gdm.service')
                        except Exception:
                            restore(); raise
                    OWNER=self.request
                    held=True
                available=bool(ready and (held or value['operation']=='status'))
                self.request.sendall(json.dumps({'available':available,'reasonCode':None if available else reason or 'cast_hdmi_display_busy'}).encode()+b'\n')
            if held:
                while not STOP.is_set() and time.time()<value['expiresAt']:
                    if select.select([self.request],[],[],.5)[0]: break
        except Exception:
            # No request body, session identifier, credentials or native data.
            pass
        finally:
            if held:
                with LOCK:
                    try: restore()
                    finally: OWNER=None

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads=False

def main():
    if os.geteuid()!=0: raise RuntimeError('root_required')
    if os.environ.get('CAST_DISPLAY_RESTORE_ONLY')=='1': restore(); return
    ROOT.mkdir(mode=0o755,exist_ok=True)
    path=ROOT/'control.sock'
    if path.exists():
        # systemd singleton; only the exact socket from our stopped unit.
        if not path.is_socket(): raise RuntimeError('socket_path_invalid')
        path.unlink()
    restore()
    monitor=HotplugMonitor()
    try:
        with LOCK:refresh_connector_status()
        with Server(str(path),Handler) as server:
            os.chown(path,65532,65532);os.chmod(path,0o600)
            server.timeout=.5
            for sig in (signal.SIGTERM,signal.SIGINT): signal.signal(sig,lambda *_:STOP.set())
            while not STOP.is_set():
                monitor.poll();server.handle_request()
    finally:monitor.close()
    restore();path.unlink(missing_ok=True)

if __name__=='__main__':main()
