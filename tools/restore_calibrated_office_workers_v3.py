#!/usr/bin/env python3
"""Restore exact office workers using actual host pressure, with no quota ledger."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import sys
import restore_calibrated_office_workers as base
from restore_calibrated_office_workers_v2 import settled_snapshot
from boot_container_memory import container_memory_rows


class CastingAdapter(base.HostAdapter):
    def __init__(self,check_only=False):
        self.check_only=check_only;self.pressure_waits=[]

    def raw_snapshot(self,value):
        return super().snapshot(value)

    def snapshot(self,value):
        at=self.monotonic()
        result,observations=settled_snapshot(value,self.raw_snapshot,self.monotonic,self.sleep,self.check_only,
                                            timeout=120)
        if len(observations)>1:
            self.pressure_waits.append(dict(seconds=self.monotonic()-at,samples=len(observations),
                 peakFullAverage10=max(s['fullAverage10'] for s in observations),
                 minAvailableBytes=min(s['availableBytes'] for s in observations),finalFullAverage10=result['fullAverage10']))
        return result


def main():
    p=argparse.ArgumentParser();p.add_argument('--configuration',required=True,type=Path);p.add_argument('--manifest',type=Path);p.add_argument('--check',action='store_true');a=p.parse_args()
    try:
        base.need(os.geteuid()==0,'root_required')
        with open('/run/lock/teamaibox-office-boot.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if not a.check:
                from ai_cache_checkpoint import finish
                finish(a.configuration,a.manifest or base.legacy.MANIFEST)
            value,entries=base.load(a.configuration,a.manifest);adapter=CastingAdapter(a.check)
            if a.check:
                result=base.restore(value,entries,adapter,True)
            else:
                from recover_ai_workers import recover, BootProgress
                result=recover(value,entries,adapter,BootProgress(value['nodeId'],
                    os.environ.get('TEAMAIBOX_AI_BOOT_STATUS_FILE','/run/teamaibox/office-boot/status.json')))
            result['pressureWaits']=adapter.pressure_waits
            print(json.dumps(result),flush=True)
        return 0
    except Exception as error:
        print(json.dumps(dict(status='failed',failure=str(error) if isinstance(error,RuntimeError) else type(error).__name__)),file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
