#!/usr/bin/env python3
"""Actual standard-adb calls through a synthetic local short-lived grant.

Inside one exact qualification container only. The ephemeral loopback listener
is a test CLI stand-in, never a published product ADB port. No user contents.
"""
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, '/opt/teamaibox')
from phone_adb_control import relay
from phone_runtime import android_processes
from phone_media_control import Streamer


def main():
    config=json.loads(Path('/run/phone/config.json').read_text())
    original_android=android_processes();original_streamer=Streamer().current()
    assert len(original_android)==1,'android_not_ready'
    base={key:config[key] for key in ('phoneId','ownerId','runId','generation')}
    base.update(id=str(uuid.uuid4()),sessionId=str(uuid.uuid4()),kind='adb')
    def control(action,grant):
        value={'action':action,'grant':grant}
        if action!='close':value['leaseExpiresAt']=int(time.time()*1000)+4000
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(3);connection.connect('/phone/.media-control.sock')
            connection.sendall(json.dumps(value).encode()+b'\n')
            return json.loads(connection.makefile('rb').readline(8193))
    def connect_grant(grant):
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        connection.settimeout(2);connection.connect('/phone/.adb-stream.sock')
        connection.sendall(json.dumps(grant).encode()+b'\n')
        expected=b'{"ready":true}\n';received=bytearray()
        while len(received)<len(expected):
            part=connection.recv(len(expected)-len(received))
            if not part:break
            received.extend(part)
        if received!=expected:
            connection.close();return None
        return connection
    assert connect_grant(base) is None,'debug_open_without_grant'
    with socket.socket() as check:
        check.settimeout(.2)
        assert check.connect_ex(('127.0.0.1',5039))!=0,'test_adb_server_port_already_used'
    adb=['/opt/cuttlefish/bin/adb','-P','5039']
    def command(*args):
        return subprocess.run([*adb,*args],capture_output=True,timeout=8,text=True)
    started=False;result={}
    try:
        assert command('start-server').returncode==0,'isolated_adb_server_failed'
        started=True
        for action in ('explicit','expiry'):
            grant=base|{'id':str(uuid.uuid4())}
            assert control('open',grant).get('peerOpen') is True,'adb_grant_open_failed'
            assert connect_grant(grant|{'kind':'control'}) is None,'control_grant_opened_debug'
            assert connect_grant(grant|{'runId':str(uuid.uuid4())}) is None,'foreign_run_opened_debug'
            upstream=connect_grant(grant);assert upstream is not None,'debug_stream_not_open'
            listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(8)
            port=listener.getsockname()[1];serial='127.0.0.1:'+str(port)
            ended=threading.Event();stop=threading.Event()
            def bridge():
                try:
                    client,_=listener.accept();listener.close();relay(client,upstream,stop)
                finally:ended.set()
            thread=threading.Thread(target=bridge,daemon=True);thread.start()
            renew_stop=threading.Event();renew_failed=[]
            def renew():
                while not renew_stop.wait(1):
                    try:
                        if control('renew',grant).get('peerOpen') is not True:renew_failed.append(True)
                    except Exception:renew_failed.append(True)
            renew_thread=threading.Thread(target=renew,daemon=True);renew_thread.start()
            try:
                connected=command('connect',serial)
                assert connected.returncode==0 and 'connected to' in connected.stdout,'standard_adb_connect_failed'
                read=command('-s',serial,'shell','getprop','sys.boot_completed')
                assert read.returncode==0 and read.stdout.strip()=='1','standard_adb_android_read_failed'
                assert not renew_failed,'debug_renew_failed'
                renew_stop.set();renew_thread.join(2)
                assert control('renew',grant).get('peerOpen') is True
                begin=time.monotonic()
                if action=='explicit':assert control('close',grant).get('peerClosed') is True,'debug_close_unconfirmed'
                assert ended.wait(8),'debug_socket_not_closed'
                elapsed=time.monotonic()-begin
                assert (elapsed<2 if action=='explicit' else 3.5<=elapsed<8),'debug_close_timing_invalid'
                assert connect_grant(grant) is None,'revoked_debug_reconnected'
                assert control('renew',grant).get('errorCode')=='phone_media_grant_revoked','revoked_debug_renewed'
                result[action+'CloseSeconds']=round(elapsed,3)
            finally:
                renew_stop.set();renew_thread.join(2);stop.set();listener.close();upstream.close();thread.join(2)
                control('close',grant)
        assert android_processes()==original_android,'debug_closed_android'
        assert Streamer().current()==original_streamer,'debug_closed_viewing'
        result.update(standardAdbAndroidRead=True,defaultClosed=True,controlGrantRejected=True,foreignRunRejected=True,
                      revokedReconnectRejected=True,actualSocketsClosed=True,androidUnchanged=True,streamerUnchanged=True,
                      publicWebSocketAccepted=False)
    finally:
        if started:assert command('kill-server').returncode==0,'isolated_adb_server_cleanup_failed'
    print(json.dumps(result))


if __name__=='__main__':main()
