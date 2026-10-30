#!/usr/bin/env python3
"""Synthetic exact-process lease test INSIDE one qualification phone.

This proves local streamer termination/recovery without stopping Android. It
does not claim LAN media, actual decoded frames or member authorization tests.
"""
import json
import os
from pathlib import Path
import socket
import sys
import time
import uuid

sys.path.insert(0,'/opt/teamaibox')
from phone_media_control import Streamer
from phone_runtime import android_processes


def main():
    config=json.loads(Path('/run/phone/config.json').read_text())
    grant={k:config[k] for k in ('phoneId','ownerId','runId','generation')}
    grant.update(id=str(uuid.uuid4()),sessionId=str(uuid.uuid4()),kind='control')
    streamer=Streamer()
    try:before=streamer.current()
    except Exception:
        # Synthetic runtime roles only, no arguments, keys or screen content.
        roles=[]
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():continue
            try:
                exe=os.readlink(entry/'exe')
                if Path(exe).name not in ('webRTC','webRTC.elf'):continue
                fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
                roles.append({'executable':exe,'parentExecutable':os.readlink(Path('/proc')/fields[1]/'exe')})
            except OSError:continue
        print(json.dumps({'streamerRoles':roles}),file=sys.stderr)
        raise
    android=android_processes()
    assert len(android)==1,'android_not_ready'
    def request(action,binding=grant):
        value={'action':action,'grant':binding}
        if action!='close':value['leaseExpiresAt']=int(time.time()*1000)+4000
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
            sock.settimeout(5);sock.connect('/phone/.media-control.sock')
            sock.sendall(json.dumps(value).encode()+b'\n');raw=bytearray()
            while not raw.endswith(b'\n') and len(raw)<=8192:
                part=sock.recv(1024)
                if not part:break
                raw.extend(part)
        return json.loads(raw)
    def replaced(old):
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            try:
                current=streamer.current()
                if current!=old and streamer.identity(old['pid'])!=old:return current
            except Exception:pass
            time.sleep(.1)
        raise RuntimeError('streamer_did_not_restart')
    assert request('open').get('peerOpen') is True,'open_failed'
    time.sleep(.25)
    assert request('renew').get('peerOpen') is True,'renew_failed'
    started=time.monotonic();reply=request('close')
    assert reply.get('peerClosed') is True,'close_unconfirmed'
    close_seconds=time.monotonic()-started
    assert streamer.identity(before['pid'])!=before,'old_streamer_still_alive'
    current=replaced(before)
    assert request('renew').get('errorCode')=='phone_media_grant_revoked','late_renew_accepted'
    second=grant|{'id':str(uuid.uuid4())}
    assert request('open',second).get('peerOpen') is True,'replacement_open_failed'
    started=time.monotonic();last=replaced(current);expire_seconds=time.monotonic()-started
    assert 3.5<=expire_seconds<9,'lease_not_bounded'
    assert request('open',second).get('errorCode')=='phone_media_grant_revoked','expired_reopen_accepted'
    third=grant|{'id':str(uuid.uuid4())}
    assert request('close',third).get('peerClosed') is True
    assert request('open',third).get('errorCode')=='phone_media_grant_revoked'
    assert streamer.current()==last,'unknown_grant_stopped_another_streamer'
    assert android_processes()==android,'android_restarted_or_stopped'
    source=json.loads(Path('/phone/cuttlefish/assembly/cuttlefish_config.json').read_text())
    selected=json.loads(Path('/phone/.media-config.json').read_text())
    key=str(config['instance'])
    assert source['instances'][key]['adb_ip_and_port'].endswith(':6540'),'guest_adb_configuration_changed'
    assert selected['instances'][key]['adb_ip_and_port']=='' and selected['instances'][key]['adb_host_port']==0,'streamer_adb_not_disabled'
    selected['instances'][key]['adb_ip_and_port']=source['instances'][key]['adb_ip_and_port']
    selected['instances'][key]['adb_host_port']=source['instances'][key]['adb_host_port']
    assert selected==source,'unrelated_configuration_changed'
    print(json.dumps({'explicitCloseSeconds':round(close_seconds,3),'leaseExpirySeconds':round(expire_seconds,3),
        'exactStreamerExited':True,'streamerRestarted':True,'androidProcessUnchanged':True,
        'lateRenewRejected':True,'expiredReopenRejected':True,'closeBeforeOpenFenced':True,
        'streamerAdbConfigurationDisabled':True,'guestAdbConfigurationUnchanged':True,'browserMediaAccepted':False}))


if __name__=='__main__':main()
