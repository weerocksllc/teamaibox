#!/usr/bin/env python3
"""Validate one exact, completed functional run; no product/lifecycle promotion."""
import argparse
import hashlib
import json
from pathlib import Path

GIB=1024**3


def require(condition,message):
    if not condition:raise ValueError(message)


def validate(guard,android,browser,require_continuous=False):
    run=guard['runId'];require(android['runId']==browser['run']==run,'run identity mismatch')
    require(all(x.get('status')=='passed' for x in (guard,android,browser)),'unsuccessful parent')
    require(guard.get('containerRemoved') is True,'test container not removed')
    require(guard.get('existingServicesUnchanged') is True and guard['containersBefore']==guard['containersAfter'],'existing service drift')
    c=guard['containerFinal']
    require(c['Id']==guard['containerId'] and c['Image']==guard['image'] and c['Name']=='/'+run,'container identity mismatch')
    require(c['Config.Labels'].get('com.teamaibox.android-lab.run')==run,'container ownership mismatch')
    require(c['HostConfig.Memory']==c['HostConfig.MemorySwap']==8*GIB and c['HostConfig.NanoCpus']==4_000_000_000,'resource limits mismatch')
    require(c['State.ExitCode']==0 and c['State.OOMKilled'] is False,'container failed')
    require(android.get('androidBooted') is True and android.get('containerKvmApi')==12 and android.get('containerEmptyVmCreated') is True,'actual KVM/Android unproven')
    require(android.get('requestedRenderer')=='guest_swiftshader' and android.get('hardwareGraphicsAccepted') is False,'renderer boundary mismatch')
    require(android.get('stopExitCode')==0,'guest cleanup failed')
    app=android.get('testApp')
    if app:
        require(app['package']=='org.fossify.math' and app['bytes']==7047681 and app['sha256']=='7c5443c22d6d62c67dfe80df33ea9161ff0fa440f92590bcb45d7008b57613ed','test APK identity mismatch')
        require('Success' in app['install'] and 'Status: ok' in app['launch'] and any('org.fossify.math' in s for s in app['focus']),'ordinary app install/run unproven')
    samples=guard['samples'];require(len(samples)>30 and min(s['availableBytes'] for s in samples)>=16*GIB,'insufficient host margin/samples')
    for sample in samples:
        group=sample.get('testCgroup')
        if group:
            events=dict(line.split() for line in group['memory.events'].splitlines())
            require(int(group['memory.swap.current'])==0 and int(events['oom'])==int(events['oom_kill'])==0,'test swapped or OOM')
    require(browser['keyboard']['text']=='TEST-123','keyboard not verified')
    require(len(browser['measurements'])==5 and all(m['done'] and 0<m['elapsedMs']<5000 and abs(m['elapsedMs']-(m['end']-m['start']))<.1 for m in browser['measurements']),'input/video timing missing')
    def audio(value):
        require(value['paused'] is False,'browser playback paused')
        require(any(s['rms']>.0002 and abs(s['peakHz']-1000)<30 for s in value['samples']),'reference tone not received')
    require(len(browser['loads'])==3,'three repetitions required')
    repeats=[]
    for load in browser['loads']:
        audio(load['audio']);duration=(load['after']['at']-load['before']['at'])/1000
        def video(value):return next(s for p in value['peers'] for s in p['stats'] if s['type']=='inbound-rtp' and s['kind']=='video')
        a,b=video(load['before']),video(load['after'])
        require(duration>=20 and b['framesDecoded']>a['framesDecoded'],'real decoded load missing')
        require(len(load['guest']['intervals'])>=300,'Android frame samples missing')
        repeats.append({'seconds':duration,'browserDecodedFps':(b['framesDecoded']-a['framesDecoded'])/duration,
            'androidFrameMeanMs':sum(load['guest']['intervals'])/len(load['guest']['intervals']),
            'droppedFrames':b['framesDropped']-a['framesDropped'],'lostPackets':b['packetsLost']-a['packetsLost']})
    require(len(browser['reconnects'])==10 and [r['n'] for r in browser['reconnects']]==list(range(1,11)),'ten reconnects required')
    for row in browser['reconnects']:
        require(row['text']=='TEST-123' and any(p['state']=='connected' for p in row['media']['peers']),'reconnect/data check failed')
    audio(browser['audioAfterReconnect'])
    continuous=browser.get('continuous')
    if require_continuous:require(continuous is not None,'full continuous playback evidence missing')
    if continuous:
        require(continuous['targetSeconds']==600 and len(continuous['windows'])==60,'sixty continuous windows required')
        previous=continuous['before'];stream_id=None
        for index,window in enumerate(continuous['windows'],1):
            require(window['index']==index and window['before']==previous,'continuous timeline gap')
            audio(window['audio']);a,b=video(previous),video(window['after'])
            stream_id=a['ssrc'] if stream_id is None else stream_id
            require(a['ssrc']==b['ssrc']==stream_id and b['framesDecoded']>a['framesDecoded'],'continuous video stopped/reset')
            require(any(p['state']=='connected' for p in window['after']['peers']),'continuous peer disconnected')
            elapsed=(window['after']['at']-previous['at'])/1000
            require(9<=elapsed<=20,'continuous sample timing outside bounds')
            previous=window['after']
        seconds=(previous['at']-continuous['before']['at'])/1000
        require(continuous['after']==previous and seconds>=600 and abs(seconds-continuous['seconds'])<.01,'continuous duration unproven')
    return {'status':'passed','runId':run,'repetitions':repeats,'clickToDecodedVideoMs':[m['elapsedMs'] for m in browser['measurements']],
        'continuousPlaybackSeconds':continuous['seconds'] if continuous else None,
        'thirdPartyAppInstalledAndOpened':bool(app),
        'browserReconnects':10,'androidLifecycleVerified':False,'lanBrowserAccepted':False,'productAccepted':False,
        'scope':'same-node synthetic functional measurement; not cold/warm benchmark, ten guest boots or physical audio acceptance'}


def main():
    p=argparse.ArgumentParser();p.add_argument('--run-dir',type=Path,required=True);p.add_argument('--browser',default='browser-measure-a1.json')
    p.add_argument('--require-continuous',action='store_true');a=p.parse_args()
    paths=[a.run_dir/n for n in ('guard.json','android-result.json',a.browser)]
    values=[json.loads(p.read_text()) for p in paths];result=validate(*values,require_continuous=a.require_continuous)
    result['files']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
