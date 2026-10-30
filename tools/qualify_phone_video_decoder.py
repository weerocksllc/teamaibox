#!/usr/bin/env python3
"""Repeatable local ARM64 decoder checks; not a phone deployment or acceptance."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
E=ROOT/'evidence/validation/virtual-phones'
IMAGE='sha256:42d8101a714bf269965e859d34676f40feaa1afdde8a4385708474687e6df685'
SOURCES=['deploy/android/cuttlefish/phone_video_camera.py',
         'deploy/android/cuttlefish/phone_video_camera_session.py',
         'deploy/android/cuttlefish/phone_camera_input.py',
         'tools/test_phone_video_camera.py','tools/qualify_phone_video_decoder.py']


def need(value,reason):
    if not value:raise RuntimeError(reason)


def sha(value):return hashlib.sha256(value).hexdigest()


def command(args,timeout=30,check=True):
    result=subprocess.run(args,capture_output=True,timeout=timeout)
    if check:need(result.returncode==0,'command_failed')
    return result


def inspect(target):return json.loads(command(['docker','inspect',target]).stdout)[0]


def verify(record):
    need(record['status']=='passed' and not record['cleanupFailures'],'run_failed')
    need(record['image']['Id']==IMAGE and record['image']['Architecture']=='arm64','image_changed')
    container=record['container'];host=container['HostConfig']
    need(container['Image']==IMAGE and container['Config']['User']=='10001:10001','runtime_changed')
    need(host['Memory']==host['MemorySwap']==512*1024**2 and host['NanoCpus']==1_000_000_000,'limits_changed')
    need(host['NetworkMode']=='none' and host['ReadonlyRootfs'] and not host['Privileged']
         and host['CapDrop']==['ALL'] and host['PidsLimit']==64,'isolation_changed')
    need('no-new-privileges' in host['SecurityOpt'] and not host['Devices'],'isolation_changed')
    mounts=container['Mounts']
    need(len(mounts)==4 and all(not v['RW'] and v['Type']=='bind' for v in mounts),'mount_changed')
    expected={str(ROOT/f):'/code/'+Path(f).name for f in SOURCES[:-1]}
    need({v['Source']:v['Destination'] for v in mounts}==expected,'source_mount_changed')
    tests=record['tests']
    need(tests['successful'] and tests['count']==19 and not tests['failures'] and not tests['errors'] and not tests['skipped'],'tests_failed')
    need(tests['gstVersion']=='1.24.2' and tests['uid']==10001,'codec_runtime_changed')
    need(0<tests['memoryPeakBytes']<=512*1024**2 and tests['memorySwapBytes']==0,'memory_failed')
    need(record['exit']['ExitCode']==0 and not record['exit']['OOMKilled'] and record['containerRemoved'],'cleanup_or_oom')
    need(record['androidTested'] is False and record['productEnabled'] is False,'scope_overclaim')


def validate(path):
    record=json.loads(path.read_bytes())
    need(path.resolve()==E/(record['runId']+'.json'),'path_changed')
    need(set(record['sources'])==set(SOURCES),'sources_missing')
    for f,h in record['sources'].items():need(sha((ROOT/f).read_bytes())==h,'source_changed')
    verify(record)
    return dict(valid=True,runId=record['runId'],sha256=sha(path.read_bytes()),androidTested=False,productEnabled=False)


def main():
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group(required=True)
    g.add_argument('--run-id');g.add_argument('--evidence',type=Path);args=p.parse_args()
    if args.evidence:print(json.dumps(validate(args.evidence)));return
    rid=args.run_id;need(re.fullmatch(r'phone-video-decoder-\d{8}-a[1-9][0-9]*',rid),'run_id_invalid')
    path=E/(rid+'.json');need(not path.exists(),'run_occupied')
    need(command(['docker','inspect',rid],check=False).returncode!=0,'container_occupied')
    image=json.loads(command(['docker','image','inspect',IMAGE]).stdout)[0]
    need(image['Id']==IMAGE and image['Architecture']=='arm64','image_changed')
    record=dict(runId=rid,status='failed',cleanupFailures=[],startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                sources={f:sha((ROOT/f).read_bytes()) for f in SOURCES},
                image={k:image[k] for k in ('Id','Architecture','Os')},androidTested=False,productEnabled=False)
    cid=None
    code="""import json,os,pathlib,sys,unittest
import test_phone_video_camera as t
suite=unittest.defaultTestLoader.loadTestsFromModule(t)
result=unittest.TextTestRunner(verbosity=2).run(suite)
root=pathlib.Path('/sys/fs/cgroup')
print(json.dumps(dict(successful=result.wasSuccessful(),count=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),gstVersion=t.Gst.version_string().split()[-1],uid=os.getuid(),memoryPeakBytes=int((root/'memory.peak').read_text()),memorySwapBytes=int((root/'memory.swap.current').read_text()))),flush=True)
sys.exit(not result.wasSuccessful())
"""
    try:
        cmd=['docker','create','--name',rid,'--label','com.teamaibox.validation-run='+rid,
             '--network','none','--read-only','--user','10001:10001','--cap-drop','ALL',
             '--security-opt','no-new-privileges','--pids-limit','64','--cpus','1',
             '--memory','512m','--memory-swap','512m','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
             '--env','PYTHONDONTWRITEBYTECODE=1','--env','PYTHONPATH=/code','--entrypoint','/usr/bin/python3']
        for f in SOURCES[:-1]:cmd+=['--mount','type=bind,src='+str(ROOT/f)+',dst=/code/'+Path(f).name+',readonly']
        cmd += [IMAGE,'-c',code]
        cid=command(cmd).stdout.decode().strip();need(re.fullmatch('[0-9a-f]{64}',cid),'container_id_invalid')
        record['container']=inspect(cid)
        result=command(['docker','start','--attach',cid],timeout=90,check=False)
        record['stdout']=result.stdout.decode();record['stderr']=result.stderr.decode()
        need(len(result.stdout)<8192 and len(result.stderr)<131072,'output_too_large')
        record['tests']=json.loads(result.stdout)
        record['exit']=inspect(cid)['State']
        need(result.returncode==0,'tests_failed');record['status']='passed'
    except Exception as error:
        record['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
    finally:
        if cid:
            try:
                owned=inspect(cid)
                need(owned['Id']==cid and owned['Image']==IMAGE and owned['Config']['Labels'].get('com.teamaibox.validation-run')==rid,'cleanup_identity_changed')
                command(['docker','rm','-f',cid])
                record['containerRemoved']=command(['docker','inspect',cid],check=False).returncode!=0
            except Exception:record['cleanupFailures'].append('container_cleanup_failed')
        if record['status']=='passed':
            try:verify(record)
            except Exception as error:record.update(status='failed',failure=str(error))
        record['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
        with path.open('x') as output:json.dump(record,output,indent=2);output.write('\n')
    if record['status']=='passed':print(json.dumps(validate(path)))
    else:print(json.dumps({k:record.get(k) for k in ('runId','status','failure','cleanupFailures')}));raise SystemExit(1)


if __name__=='__main__':main()
