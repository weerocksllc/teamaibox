#!/usr/bin/env python3
"""Exact isolated ARM64 UDP tests. No LAN listener or product capability."""
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
SOURCES=['deploy/android/cuttlefish/phone_udp_ingress.py',
         'deploy/android/cuttlefish/phone_udp_camera.py',
         'deploy/android/cuttlefish/phone_video_camera.py',
         'deploy/android/cuttlefish/phone_camera_input.py',
         'tools/test_phone_udp_ingress.py','tools/test_phone_udp_camera.py',
         'tools/qualify_phone_udp_decoder.py']

def need(v,reason):
    if not v:raise RuntimeError(reason)
def sha(v):return hashlib.sha256(v).hexdigest()
def command(args,timeout=30,check=True):
    r=subprocess.run(args,capture_output=True,timeout=timeout)
    if check:need(r.returncode==0,'command_failed')
    return r
def inspect(target):return json.loads(command(['docker','inspect',target]).stdout)[0]

def verify(r):
    need(r['status']=='passed' and not r['cleanupFailures'],'tests_failed')
    need(r['image']==dict(Id=IMAGE,Architecture='arm64',Os='linux'),'image_changed')
    c=r['container'];h=c['HostConfig']
    need(c['Image']==IMAGE and c['Config']['User']=='10001:10001','runtime_changed')
    need(c['Config']['Labels'].get('com.teamaibox.validation-run')==r['runId'],'ownership_changed')
    need(h['Memory']==h['MemorySwap']==512*1024**2 and h['NanoCpus']==1000000000,'budget_changed')
    need(h['NetworkMode']=='none' and h['ReadonlyRootfs'] and not h['Privileged'] and not h['Devices']
         and h['CapDrop']==['ALL'] and 'no-new-privileges' in h['SecurityOpt'] and h['PidsLimit']==64,'isolation_changed')
    mounts=c['Mounts'];expected={str(ROOT/f):'/code/'+Path(f).name for f in SOURCES[:-1]}
    need(len(mounts)==6 and all(m['Type']=='bind' and not m['RW'] for m in mounts)
         and {m['Source']:m['Destination'] for m in mounts}==expected,'mount_changed')
    t=r['tests'];need(t['successful'] and t['count']==20 and t['errors']==t['failures']==t['skipped']==0,'test_result_failed')
    need(t['gstVersion']=='1.24.2' and t['uid']==10001,'codec_changed')
    need(0<t['memoryPeakBytes']<=512*1024**2 and t['memorySwapBytes']==0,'memory_failed')
    need(r['exit']['ExitCode']==0 and not r['exit']['OOMKilled'] and r['containerRemoved'],'cleanup_or_oom')
    need(r['loopbackOnly'] and not any(r[k] for k in ('androidTested','productEnabled','lanPortOpened')),'scope_overclaim')

def validate(path):
    r=json.loads(path.read_bytes())
    need(re.fullmatch(r'phone-udp-decoder-\d{8}-a[1-9][0-9]*',r['runId']) and path.resolve()==E/(r['runId']+'.json'),'path_changed')
    need(set(r['sources'])==set(SOURCES),'source_missing')
    for f,h in r['sources'].items():need(sha((ROOT/f).read_bytes())==h,'source_changed')
    verify(r)
    return dict(valid=True,runId=r['runId'],sha256=sha(path.read_bytes()),tests=20,androidTested=False,productEnabled=False)

def main():
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group(required=True)
    g.add_argument('--run-id');g.add_argument('--evidence',type=Path);a=p.parse_args()
    if a.evidence:print(json.dumps(validate(a.evidence)));return
    rid=a.run_id;need(re.fullmatch(r'phone-udp-decoder-\d{8}-a[1-9][0-9]*',rid),'invalid_run')
    out=E/(rid+'.json');need(not out.exists(),'run_occupied')
    need(command(['docker','inspect',rid],check=False).returncode!=0,'container_occupied')
    image=json.loads(command(['docker','image','inspect',IMAGE]).stdout)[0]
    need(image['Id']==IMAGE and image['Architecture']=='arm64','image_changed')
    r=dict(runId=rid,status='failed',failure=None,cleanupFailures=[],
           startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
           sources={f:sha((ROOT/f).read_bytes()) for f in SOURCES},
           image={k:image[k] for k in ('Id','Architecture','Os')},
           loopbackOnly=True,lanPortOpened=False,androidTested=False,productEnabled=False)
    code="""import json,os,pathlib,sys,unittest
import test_phone_udp_ingress as a,test_phone_udp_camera as b
suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(m) for m in (a,b))
result=unittest.TextTestRunner(verbosity=2).run(suite)
root=pathlib.Path('/sys/fs/cgroup')
print(json.dumps(dict(successful=result.wasSuccessful(),count=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),gstVersion=b.Gst.version_string().split()[-1],uid=os.getuid(),memoryPeakBytes=int((root/'memory.peak').read_text()),memorySwapBytes=int((root/'memory.swap.current').read_text()))),flush=True)
sys.exit(not result.wasSuccessful())
"""
    cid=None
    try:
        cmd=['docker','create','--name',rid,'--label','com.teamaibox.validation-run='+rid,
             '--network','none','--read-only','--user','10001:10001','--cap-drop','ALL',
             '--security-opt','no-new-privileges','--pids-limit','64','--cpus','1',
             '--memory','512m','--memory-swap','512m','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
             '--env','PYTHONDONTWRITEBYTECODE=1','--env','PYTHONPATH=/code','--entrypoint','/usr/bin/python3']
        for f in SOURCES[:-1]:cmd+=['--mount','type=bind,src='+str(ROOT/f)+',dst=/code/'+Path(f).name+',readonly']
        cid=command(cmd+[IMAGE,'-c',code]).stdout.decode().strip();need(re.fullmatch('[0-9a-f]{64}',cid),'invalid_container')
        r['container']=inspect(cid)
        result=command(['docker','start','--attach',cid],timeout=90,check=False)
        need(len(result.stdout)<8192 and len(result.stderr)<131072,'output_too_large')
        r['stdout']=result.stdout.decode();r['stderr']=result.stderr.decode()
        r['tests']=json.loads(result.stdout);r['exit']=inspect(cid)['State']
        need(result.returncode==0,'tests_failed');r['status']='passed'
    except Exception as error:r['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
    finally:
        if cid:
            try:
                owned=inspect(cid)
                need(owned['Id']==cid and owned['Image']==IMAGE and owned['Config']['Labels'].get('com.teamaibox.validation-run')==rid,'cleanup_identity_changed')
                command(['docker','rm','-f',cid]);r['containerRemoved']=command(['docker','inspect',cid],check=False).returncode!=0
            except Exception:r['cleanupFailures'].append('container_cleanup_failed')
        if r['status']=='passed':
            try:verify(r)
            except Exception as error:r.update(status='failed',failure=str(error))
        r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
        with out.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    if r['status']=='passed':print(json.dumps(validate(out)))
    else:print(json.dumps({k:r[k] for k in ('runId','status','failure','cleanupFailures')}));raise SystemExit(1)

if __name__=='__main__':main()
