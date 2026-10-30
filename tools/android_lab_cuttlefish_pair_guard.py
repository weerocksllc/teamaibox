#!/usr/bin/env python3
"""Bound two independently stoppable test containers to 12 GiB / 4 CPUs total."""
import argparse
import json
from pathlib import Path
import re
import signal
import subprocess
import time
from android_lab_guard import create_args,inspect,owned,pressure_reason,cgroup_sample
from android_lab_probe import command,containers,sample,GIB


def phone_args(run,image,instance,seccomp,artifact_volume):
    match=re.fullmatch(r'(android-lab-cf-pair-\d{8}-a[1-9]\d*)-p([12])',run)
    if not match or instance!=20+int(match[2]):raise ValueError('phone identity/instance mismatch')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',artifact_volume):raise ValueError('explicit_artifact_volume_required')
    argv=create_args(match[1],image,4,'/usr/bin/python3',
        ['/lab/'+run+'.py','--run-id',run,'--instance',str(instance)],
        ['/dev/kvm','/dev/vhost-vsock'],artifact_volume,
        ['CHOWN','FOWNER','DAC_OVERRIDE','SETUID','SETGID'],seccomp)
    argv[argv.index('--name')+1]=run
    argv[argv.index('--label')+1]='com.teamaibox.android-lab.run='+run
    for flag in ('--memory','--memory-swap'):argv[argv.index(flag)+1]=str(6*GIB)
    argv[argv.index('--cpus')+1]='2'
    return argv


def run(args):
    if not re.fullmatch(r'android-lab-cf-pair-\d{8}-a[1-9]\d*',args.run_id):raise ValueError('exact pair run required')
    if command(['docker','ps','-q','--filter','label=com.teamaibox.android-lab.run']).strip():raise RuntimeError('another test is active')
    out=Path(args.output);out.mkdir(exist_ok=False)
    before=containers();first=sample()
    if first['availableBytes']<28*GIB or first['psiSomeAvg10']>=1:raise RuntimeError('12 GiB fresh admission failed')
    report={'runId':args.run_id,'image':args.image,'status':'running','containersBefore':before,'samples':[],'phones':[]}
    def interrupted(signum,frame):raise RuntimeError('controller interrupted '+str(signum))
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(sig,interrupted)
    try:
        for index in (1,2):
            name=args.run_id+'-p'+str(index);cid=command(phone_args(name,args.image,20+index,args.seccomp,args.artifact_volume)).strip()
            row={'name':name,'id':cid,'instance':20+index};report['phones'].append(row)
            state=inspect(cid)
            if not owned(state,cid,name,args.image):raise RuntimeError('phone identity mismatch')
            if state['HostConfig.Memory']!=6*GIB or state['HostConfig.MemorySwap']!=6*GIB or state['HostConfig.NanoCpus']!=2_000_000_000:
                raise RuntimeError('phone quota mismatch')
            command(['systemd-run','--unit='+name+'-deadline','--on-active=720s','--timer-property=AccuracySec=1s','/usr/bin/docker','stop','-t','3',cid])
        for row in report['phones']:command(['docker','start',row['id']])
        start=time.monotonic();next_health=start
        while True:
            states=[inspect(row['id']) for row in report['phones']]
            if any(s['State.Status']!='running' and s['State.ExitCode']!=0 for s in states):raise RuntimeError('phone failed')
            now=sample();now['phones']=[{'name':row['name'],'state':s['State.Status'],'cgroup':cgroup_sample(s)} for row,s in zip(report['phones'],states)]
            report['samples'].append(now)
            if pressure_reason(report['samples']):raise RuntimeError(pressure_reason(report['samples']))
            if all(s['State.Status']!='running' for s in states):break
            if time.monotonic()-start>700:raise RuntimeError('pair deadline')
            if time.monotonic()>=next_health:
                live={c['id']:c for c in containers()}
                if any(live.get(c['id'])!=c for c in before):raise RuntimeError('existing services drifted')
                next_health=time.monotonic()+15
            time.sleep(1)
        report['status']='passed'
    except Exception as e:report.update(status='failed',error=str(e))
    finally:
        for row in report['phones']:
            try:
                state=inspect(row['id'])
                if not owned(state,row['id'],row['name'],args.image):raise RuntimeError('cleanup identity mismatch')
                command(['docker','stop','-t','3',row['id']]);row['final']=inspect(row['id'])
                logs=subprocess.run(['docker','logs','--tail','500',row['id']],capture_output=True,timeout=15)
                (out/(row['name']+'.stdout')).write_bytes(logs.stdout);(out/(row['name']+'.stderr')).write_bytes(logs.stderr)
                command(['docker','rm',row['id']]);row['removed']=True
                subprocess.run(['systemctl','stop',row['name']+'-deadline.timer'],capture_output=True,timeout=15)
            except Exception as e:report.update(status='failed',cleanupError=str(e))
        report['containersAfter']=containers();report['existingServicesUnchanged']=report['containersAfter']==before
        if not report['existingServicesUnchanged']:report['status']='failed'
        with (out/'guard.json').open('x') as f:json.dump(report,f,indent=2)
    print(json.dumps({k:report.get(k) for k in ('runId','status','error','cleanupError','existingServicesUnchanged')}))
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);p.add_argument('--image',required=True)
    p.add_argument('--output',required=True);p.add_argument('--seccomp',required=True)
    p.add_argument('--artifact-volume',required=True)
    raise SystemExit(run(p.parse_args()))
