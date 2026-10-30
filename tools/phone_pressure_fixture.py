#!/usr/bin/env python3
"""Bounded anonymous RAM fixture. No workload stop, network or disk writes.

Inside a no-swap container; reads only host memory counters and the two supplied
test phone records. Independent alarm and safety floor release all allocations.
"""
import datetime as dt
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid

GIB=1024**3
FLOOR=int(14.5*GIB)
TARGET=int(15.7*GIB)
MAX_BYTES=30*GIB
MAX_SECONDS=240
MAX_SWAPOUT=64*1024**2
MAX_PSI=10
MAX_FULL_PSI=2


def pressure_action(readings):
    """Separate emergency abort from the product's sustained-pressure window.

    Small host page-outs are not a failed phone. Hold allocation when the
    product may need its ten-second observation window; never keep adding RAM
    through sustained pressure. No host/cgroup policy is changed by this probe.
    """
    first,last=readings[0],readings[-1]
    if (last['swapout']-first['swapout']>MAX_SWAPOUT or last['psi']>=MAX_PSI or
            last['psiFull']>=MAX_FULL_PSI):return 'safety-pressure'
    recent=[v for v in readings if last['seconds']-v['seconds']<=2.5]
    old=recent[0];span=last['seconds']-old['seconds']
    rate=(last['swapout']-old['swapout'])/span if span else 0
    return 'hold' if last['psi']>=5 or rate>1024**2 else 'allocate'


def allocation_step(available, allocated, elapsed, protected):
    if protected:return 'protected'
    if available<FLOOR:return 'safety-floor'
    if elapsed>=MAX_SECONDS:return 'deadline'
    if available<=TARGET:return 'hold'
    if allocated>=MAX_BYTES:return 'allocation-cap'
    return 'allocate'


def sample(ids):
    m={v.split(':')[0]:int(v.split()[1])*1024 for v in Path('/host-meminfo').read_text().splitlines()}
    pressure=Path('/host-memory-pressure').read_text().splitlines()
    psi={line.split()[0]:float(dict(x.split('=') for x in line.split()[1:])['avg10']) for line in pressure}
    vm=dict(v.split() for v in Path('/host-vmstat').read_text().splitlines())
    j=json.loads(Path('/phone-journal/phones.json').read_text())
    records={pid:{k:j['phones'][pid].get(k) for k in ('phase','protectionReason','startedAtUnixMs')} for pid in ids}
    return dict(available=m['MemAvailable'],psi=psi['some'],psiFull=psi['full'],
                observedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                swapout=int(vm['pswpout'])*os.sysconf('SC_PAGE_SIZE'), phones=records,
                reclaimedFilePages=int(vm['pgsteal_file']),reclaimedAnonPages=int(vm['pgsteal_anon']),
                directReclaimPages=int(vm['pgsteal_direct']),compactionStalls=int(vm['compact_stall']))


def main(ids):
    assert len(ids)==2 and all(str(uuid.UUID(pid))==pid for pid in ids) and len(set(ids))==2
    assert os.getuid()==10001
    cgroup=Path('/sys/fs/cgroup')
    assert int((cgroup/'memory.max').read_text())==32*GIB and (cgroup/'memory.swap.max').read_text().strip()=='0'
    def alarm(*_):raise TimeoutError('independent_alarm')
    signal.signal(signal.SIGALRM,alarm);signal.alarm(MAX_SECONDS+5)
    blocks=[]; allocated=0; start=time.monotonic(); readings=[]; reason='failed'
    try:
        initial=sample(ids)
        assert initial['available']>=22*GIB and initial['psi']<1
        assert all(v['phase']=='running' and not v['protectionReason'] for v in initial['phones'].values())
        while True:
            s=sample(ids);elapsed=time.monotonic()-start
            s.update(seconds=round(elapsed,3),allocatedBytes=allocated);readings.append(s)
            protected=any(v['protectionReason'] for v in s['phones'].values())
            action=allocation_step(s['available'],allocated,elapsed,protected)
            if action not in ('allocate','hold'):reason=action;break
            pressure=pressure_action(readings)
            if pressure=='safety-pressure':reason=pressure;break
            if pressure=='hold':action='hold'
            if action=='allocate':
                # Anonymous dirty pages count toward memory.max; no disk or swap.
                # Small paced allocations; hold at a product pressure signal.
                block=bytearray(16*1024**2)
                block[::4096]=b'\x01'*(len(block)//4096)
                blocks.append(block);allocated+=len(block)
            time.sleep(.125)
    except Exception as e:reason=type(e).__name__
    finally:
        blocks.clear();block=None;signal.alarm(0)
    result=dict(status='passed' if reason=='protected' else 'failed',reason=reason,readings=readings,
                releasedBytes=allocated,seconds=round(time.monotonic()-start,3),
                floorBytes=FLOOR,targetBytes=TARGET,maxBytes=MAX_BYTES,maxSeconds=MAX_SECONDS,
                protocolVersion=2,maxSwapoutBytes=MAX_SWAPOUT,maxPSI=MAX_PSI,maxFullPSI=MAX_FULL_PSI)
    print(json.dumps(result),flush=True)
    return 0 if reason=='protected' else 1


if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
