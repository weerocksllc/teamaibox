#!/usr/bin/python3
"""Short namespace init followed by the existing non-root phone runtime."""
import json
import os
from pathlib import Path
import stat
import sys

from phone_network import initialize, recipe
from phone_runtime import CONFIG, PhoneError, Runtime, closed_json, launch_arguments, main, validate_config

READY=Path('/run/phone-network.ready')


def network_launch_arguments(config):
    network=recipe(config['instance'])
    args=launch_arguments(config)
    if args.count('--enable_tap_devices=false')!=1:
        raise PhoneError('phone_network_launch_invalid')
    args[args.index('--enable_tap_devices=false')]='--enable_tap_devices=true'
    # First release uses the mobile interface for app internet. Unconfigured
    # Wi-Fi/ethernet interfaces must not become an alternative egress path.
    ports=f"{network['mediaFirst']}:{network['mediaLast']}"
    return args+['--enable_wifi=false','--ril_dns=1.1.1.1',
                 '--tcp_port_range='+ports,'--udp_port_range='+ports]


class NetworkRuntime(Runtime):
    def launch_arguments(self):
        return network_launch_arguments(self.config)


def drop_arguments(device_groups):
    if any(type(g) is not int or g<=0 for g in device_groups):raise PhoneError('phone_runtime_device_group_invalid')
    groups=','.join(str(g) for g in sorted({1000,1001,*device_groups}))
    return ['/usr/bin/setpriv','--reuid=10001','--regid=10001','--groups='+groups,
            '--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs',
            '/usr/bin/python3','/opt/teamaibox/phone_network_start.py','serve']


def read_config():
    # The declaration belongs to the runtime UID and stays mode 0400/0600.
    # Namespace init has no DAC_OVERRIDE, so even UID 0 must read it as its
    # owner. SETUID is already needed for the final irreversible privilege drop.
    previous=os.geteuid()
    if previous==0:os.seteuid(10001)
    try:return validate_config(closed_json(CONFIG.read_bytes()[:4097]))
    finally:
        if previous==0:os.seteuid(0)


def start():
    if sys.argv[1:]!=['serve']:raise PhoneError('phone_network_action_invalid')
    config=read_config()
    expected=json.dumps({'version':1,'instance':config['instance']},sort_keys=True).encode()
    if os.getuid()==0:
        initialize(config['instance'])
        fd=os.open(READY,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
        try:os.write(fd,expected);os.fsync(fd)
        finally:os.close(fd)
        args=drop_arguments([os.stat(p).st_gid for p in ('/dev/kvm','/dev/vhost-vsock')]);os.execv(args[0],args)
    if os.getuid()!=10001:raise PhoneError('phone_runtime_user_invalid')
    metadata=READY.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=0 or stat.S_IMODE(metadata.st_mode)!=0o444 or READY.read_bytes()!=expected:
        raise PhoneError('phone_network_not_initialized')
    status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    if any(int(status[k].strip(),16)!=0 for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')) or status['NoNewPrivs'].strip()!='1':
        raise PhoneError('phone_runtime_capability_not_dropped')
    return main(NetworkRuntime)


if __name__=='__main__':
    try:raise SystemExit(start())
    except (PhoneError,RuntimeError) as e:
        print(json.dumps({'errorCode':str(e)}));raise SystemExit(1)
