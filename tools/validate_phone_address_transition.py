#!/usr/bin/env python3
"""Bounded test-only secondary address; never removes the primary address.

Requires exactly the named temporary phone to be running. An independent
systemd timer restores forwarding and the original watcher after three minutes.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import socket
import struct
import time
from appliance_installation import execute, load
from appliance_network_identity import atomic_write, discover
from appliance_phone_media import reconcile

UNIT='teamaibox-portable-media-restore'


def unused(interface,address):
    mac=bytes.fromhex(Path('/sys/class/net',interface,'address').read_text().strip().replace(':',''))
    target=socket.inet_aton(address)
    packet=b'\xff'*6+mac+b'\x08\x06'+struct.pack('!HHBBH',1,0x0800,6,4,1)+mac+b'\0'*4+b'\0'*6+target
    with socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(0x0806)) as s:
        s.bind((interface,0));s.settimeout(.15)
        for _ in range(3):
            s.send(packet);end=time.monotonic()+.5
            while time.monotonic()<end:
                try:reply=s.recv(2048)
                except socket.timeout:continue
                if len(reply)>=42 and reply[22:28]!=mac and reply[28:32]==target:raise ValueError('test_address_in_use')


def restore(state_path):
    state=json.loads(Path(state_path).read_text());config=state['config']
    rows=json.loads(execute(['ip','-j','address','show']))
    addresses=[a for a in discover() if a!=state['address']]
    reconcile(config,addresses,rows,atomic_write)
    current=next(r for r in rows if r['ifname']==state['interface'])
    if any(a.get('local')==state['address'] for a in current['addr_info']):
        execute(['ip','address','del',state['cidr'],'dev',state['interface']])
    if state['timerEnabled']:execute(['systemctl','start','teamaibox-network-identity.timer'])
    state['restored']=True;atomic_write(state_path,(json.dumps(state)+'\n').encode(),0o600)
    return {'status':'restored','primaryAddressChanged':False}


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['switch','offline','restore']);p.add_argument('--state',required=True)
    p.add_argument('--installation',default='/etc/teamaibox/installation.json');p.add_argument('--phone-id');p.add_argument('--address')
    args=p.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    if args.action=='restore':print(json.dumps(restore(args.state)));return
    if args.action=='offline':
        state=json.loads(Path(args.state).read_text());reconcile(state['config'],[],[],atomic_write)
        print(json.dumps({'status':'waiting_for_network','scope':'observed-address-state-only'}));return
    record=load(args.installation);identity=json.loads(Path(record['references']['networkIdentity']).read_text())
    config=identity['phoneMedia']
    ids=execute(['docker','ps','-q','--no-trunc','--filter','label=com.teamaibox.kind=android-phone']).split()
    containers=json.loads(execute(['docker','inspect',*ids])) if ids else []
    if len(containers)!=1 or containers[0]['Config']['Labels']['com.teamaibox.phone-id']!=args.phone_id:
        raise ValueError('only_explicit_temporary_phone_may_be_running')
    address=str(ipaddress.IPv4Address(args.address));rows=json.loads(execute(['ip','-j','address','show']))
    primary=discover()[0]
    row=next(r for r in rows if any(a.get('local')==primary for a in r.get('addr_info',[])))
    info=next(a for a in row['addr_info'] if a.get('local')==primary)
    subnet=ipaddress.ip_network(primary+'/'+str(info['prefixlen']),strict=False)
    if ipaddress.ip_address(address) not in subnet or address in discover():raise ValueError('test_secondary_address_invalid')
    unused(row['ifname'],address)
    timer=execute(['systemctl','show','-p','ActiveState','--value','teamaibox-network-identity.timer']).strip()=='active'
    state=dict(address=address,cidr=address+'/'+str(info['prefixlen']),interface=row['ifname'],timerEnabled=timer,config=config,
               phoneContainerId=containers[0]['Id'],phoneStartedAt=containers[0]['State']['StartedAt'])
    atomic_write(args.state,(json.dumps(state)+'\n').encode(),0o600)
    execute(['systemd-run','--unit='+UNIT,'--on-active=180s','/usr/bin/python3',str(Path(__file__).resolve()),'restore','--state',args.state])
    try:
        execute(['systemctl','stop','teamaibox-network-identity.timer'])
        execute(['ip','address','add',state['cidr'],'dev',state['interface']])
        reconcile(config,[address],json.loads(execute(['ip','-j','address','show'])),atomic_write)
    except Exception:
        restore(args.state);raise
    print(json.dumps({'status':'switched','secondaryAddress':address,'phoneContainerId':state['phoneContainerId'],'phoneStartedAt':state['phoneStartedAt'],'automaticRestoreSeconds':180}))


if __name__=='__main__':main()
