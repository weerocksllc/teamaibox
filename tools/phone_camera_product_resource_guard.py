"""Bounded, node-local protection for one synthetic qualification container.

Uses existing host Python, no daemon/install and no changes to office services.
Sampling does not depend on SSH round trips. Only the exact labelled test
container may be stopped; normal cleanup remains the qualification's job.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from phone_gapps_pressure import RuntimePressure

RUN_ID = re.compile(r'phone-camera-(?:(?:product|video)-hal|lifecycle-(?:google|standard))-\d{8}-a[1-9][0-9]*')


def host_sample(proc=Path('/proc')):
    memory={l.split(':')[0]:int(l.split()[1])*1024 for l in (proc/'meminfo').read_text().splitlines()}
    pressure=(proc/'pressure/memory').read_text().splitlines()[0]
    vm=dict(l.split() for l in (proc/'vmstat').read_text().splitlines())
    return dict(available=memory['MemAvailable'],psi=float(dict(x.split('=') for x in pressure.split()[1:])['avg10']),
                swapout=int(vm['pswpout'])*os.sysconf('SC_PAGE_SIZE'))


def phone_sample(group):
    return {k:(dict((a,int(b)) for a,b in (l.split() for l in (group/k).read_text().splitlines()))
               if k=='memory.events' else int((group/k).read_text()))
            for k in ('memory.current','memory.peak','memory.swap.current','memory.events')}


def validate_identity(item,cid,image,rid):
    if (item['Id']!=cid or item['Image']!=image or item['Name']!='/'+rid or
        item['Config']['Labels'].get('com.teamaibox.guest-network')!=rid or
        item['HostConfig']['Memory']!=6*1024**3 or item['HostConfig']['MemorySwap']!=6*1024**3):
        raise RuntimeError('guard_identity_mismatch')


def main():
    cid,image,rid=sys.argv[1:]
    if (os.getuid()!=0 or not re.fullmatch(r'[0-9a-f]{64}',cid) or
        not re.fullmatch(r'sha256:[0-9a-f]{64}',image) or
        not RUN_ID.fullmatch(rid)):
        raise RuntimeError('guard_arguments_invalid')
    output=Path(__file__).with_name('resources.jsonl')
    policy=RuntimePressure();start=time.monotonic();previous=None;group=None

    def inspect():
        r=subprocess.run(['docker','inspect',cid],capture_output=True,check=True,timeout=6)
        item=json.loads(r.stdout)[0];validate_identity(item,cid,image,rid);return item

    def stop_owned():
        item=inspect()
        if item['State']['Running']:
            subprocess.run(['docker','stop','--time','75',cid],capture_output=True,check=True,timeout=90)

    with output.open('x') as report:
        os.chmod(output,0o400)
        def emit(value):
            report.write(json.dumps(value)+'\n');report.flush()
        try:
            while time.monotonic()-start<600:
                item=inspect()
                if not item['State']['Running']:
                    if group is not None:
                        emit(dict(event='stopped',containerId=cid));return 0
                    if time.monotonic()-start>15:raise RuntimeError('guard_start_timeout')
                    time.sleep(.25);continue
                if group is None:
                    lines=Path('/proc',str(item['State']['Pid']),'cgroup').read_text().splitlines()
                    relative=next(l[3:] for l in lines if l.startswith('0::'))
                    if relative not in ('/system.slice/docker-'+cid+'.scope','/docker/'+cid):
                        raise RuntimeError('guard_cgroup_identity_mismatch')
                    group=Path('/sys/fs/cgroup')/relative.lstrip('/')
                at=time.monotonic()-start;host=host_sample()
                try:phone=phone_sample(group)
                except FileNotFoundError:
                    if not inspect()['State']['Running']:
                        emit(dict(event='stopped',containerId=cid));return 0
                    raise
                emit(dict(event='sample',atSeconds=at,observedAtUnix=time.time(),host=host,phone=phone))
                if previous is not None and not 0<at-previous<=8:raise RuntimeError('resource_sampling_gap')
                previous=at;policy.check(at,host)
                if phone['memory.swap.current'] or phone['memory.events']['oom'] or phone['memory.events']['oom_kill']:
                    raise RuntimeError('phone_memory_failed')
                time.sleep(1)
            raise RuntimeError('guard_deadline')
        except Exception as error:
            emit(dict(event='failed',failure=str(error) if isinstance(error,RuntimeError) else type(error).__name__))
            stop_owned()
            return 1


if __name__=='__main__':raise SystemExit(main())
