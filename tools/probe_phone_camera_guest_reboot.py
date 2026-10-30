#!/usr/bin/env python3
"""Read-only guest metadata around one actual reboot of a synthetic phone."""
import json,subprocess,time
from pathlib import Path

config=json.loads(Path('/run/phone/config.json').read_bytes())
adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:'+str(6519+config['instance'])]
def shell(*args):
    return subprocess.run(adb+['shell',*args],capture_output=True,timeout=8,check=True).stdout.decode().strip()
def boot():return dict(completed=shell('getprop','sys.boot_completed'),id=shell('cat','/proc/sys/kernel/random/boot_id'))
old=boot();assert old['completed']=='1'
started=time.monotonic();subprocess.run(adb+['reboot'],capture_output=True,timeout=10,check=True)
new=None
while time.monotonic()-started<85:
    time.sleep(2)
    try:v=boot()
    except (subprocess.SubprocessError,OSError):continue
    if v['completed']=='1' and v['id']!=old['id']:new=v;break
if not new:
    path=Path('/phone/cuttlefish/instances')/('cvd-'+str(config['instance']))/'logs/launcher.log'
    lines=path.read_text(errors='replace').splitlines() if path.exists() else []
    # This probe operates only on a fresh synthetic guest; no personal content.
    diagnostic=[line[:650] for line in lines if ('crosvm ' in line or 'process_restarter ' in line)
                and 'subprocess.cpp:474' not in line][-45:]
    print(json.dumps(dict(status='failed',before=old,reason='guest_did_not_reboot',diagnostic=diagnostic)),flush=True)
    raise SystemExit(1)
print(json.dumps(dict(status='passed',before=old,after=new,seconds=time.monotonic()-started,
    accountDataAccessed=False,syntheticOnly=True,containerRestarted=False)))
