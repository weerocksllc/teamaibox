#!/usr/bin/env python3
"""Check exact lifecycle evidence, including every real browser restart receipt."""
import argparse
import hashlib
import json
from pathlib import Path
from validate_android_lab_cuttlefish_functional import require,GIB


def validate(guard,android,browsers):
    run=guard['runId'];require(android['runId']==run,'run identity mismatch')
    require(guard['status']==android['status']=='passed','failed run')
    require(guard.get('containerRemoved') is True and guard.get('existingServicesUnchanged') is True,'cleanup/service check failed')
    require(guard['containersBefore']==guard['containersAfter'],'old containers drifted')
    final=guard['containerFinal']
    require(final['Id']==guard['containerId'] and final['Image']==guard['image'] and final['Name']=='/'+run,'container identity mismatch')
    require(final['Config.Labels'].get('com.teamaibox.android-lab.run')==run,'container ownership mismatch')
    require(final['HostConfig.Memory']==final['HostConfig.MemorySwap']==8*GIB and final['HostConfig.NanoCpus']==4_000_000_000,'wrong resource limits')
    require(final['State.ExitCode']==0 and final['State.OOMKilled'] is False,'container exited badly')
    require(android['kvmApi']==12 and android['hardwareGraphicsAccepted'] is False,'KVM/graphics boundary')
    require(android['finalStopExit']==0,'final guest stop failed')
    rows=android['cycles'];require(len(rows)==len(browsers)==10,'ten complete cycles required')
    require([r['index'] for r in rows]==list(range(1,11)),'cycle sequence mismatch')
    require(len({r['bootId'] for r in rows})==10,'ten distinct guest boots required')
    require(len({r['androidId'] for r in rows})==1 and rows[0]['androidId'] not in ('','null'),'persistent device identity not demonstrated')
    app=android['testApp']['package'];require(app in ('com.android.settings','org.fossify.math'),'unknown test app scope')
    if app=='org.fossify.math':
        require('Success' in rows[0]['install'] and android['testApp']['sha256']=='7c5443c22d6d62c67dfe80df33ea9161ff0fa440f92590bcb45d7008b57613ed','test APK not installed/verified')
    require(isinstance(rows[4].get('forcedVmExitPid'),int),'controlled VM crash not recorded')
    for row,browser in zip(rows,browsers):
        require(browser==row['browser'],'browser receipt mismatch')
        require(browser['runId']==run and browser['cycle']==row['index'] and browser['bootId']==row['bootId'] and browser['status']=='passed','browser/boot identity mismatch')
        require(all(row[k]==android['markerSha256'] for k in ('privateSha','sharedSha','roundtripSha')),'file persistence failed')
        require(row['deviceName']=='Team-AI-lab-phone' and row['stopExit']==0,'device name/stop failed')
        require(any(app in line for line in row['appFocus']),'test app was not focused')
        before=[s for p in browser['before']['peers'] for s in p['stats']]
        after=[s for p in browser['after']['peers'] for s in p['stats']]
        require(any(b['ssrc']==a['ssrc'] and b['framesDecoded']>a['framesDecoded'] for a in before for b in after),'browser video did not advance')
        require(browser['after']['video']=={'width':720,'height':1280},'unexpected actual video size')
    require(min(s['availableBytes'] for s in guard['samples'])>=16*GIB,'host margin exhausted')
    for s in guard['samples']:
        c=s.get('testCgroup')
        if c:
            e=dict(line.split() for line in c['memory.events'].splitlines())
            require(int(c['memory.swap.current'])==int(e['oom'])==int(e['oom_kill'])==0,'swap/OOM occurred')
    return {'status':'passed','runId':run,'distinctGuestBoots':10,'browserCycles':10,'forcedVmCrashRecovered':True,
            'fileRoundTrips':10,'phoneIdentityRetained':True,'bootSeconds':[r['bootSeconds'] for r in rows],
            'multiPhoneIsolationAccepted':False,'thirdPartyInstallAccepted':app=='org.fossify.math','googlePlayAccepted':False,'productAccepted':False}


def main():
    p=argparse.ArgumentParser();p.add_argument('--run-dir',type=Path,required=True);a=p.parse_args()
    paths=[a.run_dir/'guard.json',a.run_dir/'android-result.json',*[a.run_dir/f'browser-{i}.json' for i in range(1,11)]]
    docs=[json.loads(p.read_text()) for p in paths];result=validate(docs[0],docs[1],docs[2:])
    result['files']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};print(json.dumps(result,indent=2))


if __name__=='__main__':main()
