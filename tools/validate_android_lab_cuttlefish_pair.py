#!/usr/bin/env python3
"""Validate two real independent phones, not two browser windows of one guest."""
import argparse
import hashlib
import json
from pathlib import Path
from validate_android_lab_cuttlefish_functional import require,GIB


def progress(a,b):
    before=[s for p in a['peers'] for s in p['stats']];after=[s for p in b['peers'] for s in p['stats']]
    require(any(p['state']=='connected' for p in b['peers']),'peer disconnected')
    require(any(x['ssrc']==y['ssrc'] and y['framesDecoded']>x['framesDecoded'] for x in before for y in after),'no real advancing video')


def validate(guard,phones,browser):
    run=guard['runId'];require(browser['runId']==run,'cross-run browser')
    require(guard['status']==browser['status']=='passed','pair failed')
    require(len(guard['phones'])==len(phones)==len(browser['phones'])==2,'two phones required')
    require(guard['existingServicesUnchanged'] and guard['containersBefore']==guard['containersAfter'],'existing services drifted')
    require(len({p['androidId'] for p in phones})==2 and all(p['androidId'] not in ('','null') for p in phones),'not two distinct Android identities')
    for n,(owned,phone,view) in enumerate(zip(guard['phones'],phones,browser['phones']),1):
        name=run+'-p'+str(n);final=owned['final']
        require(owned['name']==phone['runId']==view['name']==name and phone['instance']==20+n,'phone ownership mismatch')
        require(final['Id']==owned['id'] and final['Name']=='/'+name and final['Image']==guard['image'] and final['Config.Labels']['com.teamaibox.android-lab.run']==name,'container identity mismatch')
        require(final['HostConfig.Memory']==final['HostConfig.MemorySwap']==6*GIB and final['HostConfig.NanoCpus']==2_000_000_000,'pair quota exceeded')
        require(owned['removed'] and final['State.ExitCode']==0 and final['State.OOMKilled'] is False,'cleanup/exit failed')
        require(phone['status']=='passed' and phone['kvmApi']==12 and phone['stopExit']==0,'phone KVM/lifecycle failed')
        require(view['androidId']==phone['androidId'] and view['keyboard']=='phone-'+str(n),'phone browser identity/input mismatch')
        require(phone['renderer']=='guest_swiftshader' and phone['hardwareGraphicsAccepted'] is False,'graphics boundary mismatch')
        for files in (phone['filesBefore'],phone['filesAfter']):
            require(files['sha256']==files['roundtripSha256']==phone['markerSha256'] and files['otherFileAbsent'] and files['hostLabPathAbsent'],'phone file isolation failed')
    require(len(browser['concurrent'])==3,'three concurrent windows required')
    for window in browser['concurrent']:
        require(len(window['before'])==len(window['after'])==len(window['guest'])==2,'concurrent sample incomplete')
        for i in range(2):
            progress(window['before'][i],window['after'][i])
            require(window['after'][i]['at']-window['before'][i]['at']>=10000,'concurrent load too short')
            require(window['guest'][i]['text']=='phone-'+str(i+1) and len(window['guest'][i]['intervals'])>=100,'independent active fixture missing')
    require(browser['firstPhoneStopped']=={'runId':run+'-p1','status':'exited'},'first phone not stopped')
    progress(browser['survivorBeforeStop']['media'],browser['survivorAfterStop']['media'])
    require(browser['survivorAfterStop']['guest']['text']=='survivor-2','surviving phone not operable')
    require(len(guard['samples'])>=30 and min(s['availableBytes'] for s in guard['samples'])>=16*GIB,'host margin/samples failed')
    for sample in guard['samples']:
        for row in sample['phones']:
            group=row['cgroup']
            if group:
                events=dict(line.split() for line in group['memory.events'].splitlines())
                require(int(group['memory.swap.current'])==int(events['oom'])==int(events['oom_kill'])==0,'test swapped or OOM')
    return {'runId':run,'status':'passed','phones':2,'totalMemoryGiB':12,'totalCpuLimit':4,
        'independentGuestDataVerified':True,'singlePhoneStopBoundaryVerified':True,'fourPhonesAccepted':False,
        'tenantAuthorizationAccepted':False,'hardwareGraphicsAccepted':False,'productAccepted':False}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run-dir',type=Path,required=True);a=p.parse_args()
    paths=[a.run_dir/n for n in ('guard.json','phone-1.json','phone-2.json','browser.json')]
    data=[json.loads(p.read_text()) for p in paths];result=validate(data[0],data[1:3],data[3])
    result['files']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};print(json.dumps(result,indent=2))
