#!/usr/bin/env python3
"""Bounded cold-load pressure settling; all existing memory limits remain.

No further model starts while memory PSI is elevated. During the wait,
Actual host pressure and owned worker failures remain observable. Persistent pressure fails and the
original helper rolls back only this invocation's starts. Warm checks never wait.
"""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import sys
import restore_calibrated_office_workers as base


def settled_snapshot(value, sample, monotonic, sleep, check_only=False, timeout=60):
    deadline=monotonic()+timeout;observations=[]
    while True:
        snapshot=sample(value)
        psi=snapshot.get('fullAverage10')
        base.need(type(psi) in (int,float) and math.isfinite(psi) and psi>=0,'invalid_boot_memory_evidence')
        base.observe(value,{**snapshot,'fullAverage10':0.0},set())
        observations.append(snapshot)
        if psi<.1:return snapshot,observations
        if check_only or monotonic()>=deadline:
            raise RuntimeError(json.dumps(dict(code='boot_memory_pressure',rejectedSnapshot=snapshot,
                                              pressureWaitSeconds=timeout if not check_only else 0))) from None
        sleep(min(3,deadline-monotonic()))


class PressureAdapter(base.HostAdapter):
    def __init__(self,check_only=False):
        self.check_only=check_only;self.pressure_waits=[]

    def snapshot(self,value):
        at=self.monotonic()
        snapshot,observations=settled_snapshot(value,super().snapshot,self.monotonic,self.sleep,self.check_only)
        if len(observations)>1:
            self.pressure_waits.append(dict(seconds=self.monotonic()-at,samples=len(observations),
                 peakFullAverage10=max(s['fullAverage10'] for s in observations),
                 minAvailableBytes=min(s['availableBytes'] for s in observations),
                 finalFullAverage10=snapshot['fullAverage10']))
        return snapshot


def main():
    p=argparse.ArgumentParser();p.add_argument('--configuration',required=True,type=Path);p.add_argument('--manifest',type=Path);p.add_argument('--check',action='store_true');a=p.parse_args()
    try:
        base.need(os.geteuid()==0,'root_required')
        with open('/run/lock/teamaibox-office-boot.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            value,entries=base.load(a.configuration,a.manifest);adapter=PressureAdapter(a.check)
            result=base.restore(value,entries,adapter,a.check)
            result['pressureWaits']=adapter.pressure_waits
            print(json.dumps(result),flush=True)
        return 0
    except Exception as error:
        print(json.dumps(dict(status='failed',failure=str(error) if isinstance(error,RuntimeError) else type(error).__name__)),file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
