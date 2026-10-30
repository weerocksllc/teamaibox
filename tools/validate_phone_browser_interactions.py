#!/usr/bin/env python3
"""Actual member browser refresh/logout proof, separate from continuous playback."""
import argparse,json,re
from pathlib import Path
from validate_phone_member_media import ROOT,E,need,sha,stamp,controller_checks

def checks(r,parent,observation):
    need(r['status']=='passed' and r['observationMethod']=='actual-system-trusted-browser','browser_not_observed')
    need(r['phoneId']==parent['phoneId']==observation['phoneId'] and r['memberLogin']==parent['runId'],'wrong_member_or_phone')
    need([v['cycle'] for v in r['reloads']]==list(range(1,11)),'ten_refreshes_missing')
    for v in r['reloads']:
        need(v['width']==720 and v['height']==1280 and v['ready']==4 and v['time']>0 and not v['paused'],'actual_frame_missing')
    a=r['audioAfterExplicitEnable'];need(a['ready']==4 and a['time']>0 and not a['paused'] and not a['muted'],'audio_not_resumed')
    need(r['automaticConnection'] and r['pointerAndKeyboardObserved'],'input_missing')
    need(observation['status']=='passed' and observation['readOnly'] and observation['exitCode']==0,'observer_failed')
    need(observation['sourceSha256']==sha((ROOT/'tools/observe_phone_peer.py').read_bytes()),'observer_source_changed')
    samples=observation['samples'];need(len(samples)>=20 and observation['containerId']==parent['runtimeBefore']['id'],'wrong_runtime')
    logout=stamp(r['logoutAt']);before=[v for v in samples if v['at']<logout];after=[v for v in samples if v['at']>=logout]
    need(before and after and before[-1]['peersGone'] is False,'live_peer_not_observed')
    closed=next((v for v in after if v['peersGone']),None)
    need(closed is not None and 0<=closed['at']-logout<=10,'actual_peer_revoke_timeout')
    need(all(v['peersGone'] for v in after if v['at']>=closed['at']),'peer_returned_after_logout')
    for a,b in zip(samples,samples[1:]):need(0<b['at']-a['at']<=3,'observer_gap')
    need(all(v['android']==samples[0]['android'] and v['streamer']==samples[0]['streamer'] and v['memory.swap.current']==0 and v['memory.peak']<=6*1024**3 for v in samples),'guest_restarted_or_limit_exceeded')
    v=r['browserAfterLogout'];need(0<=stamp(v['at'])-logout<=10 and v['hasStream'] is False and v['ready']==0 and v['paused'] is True and v['loginExpiredVisible'],'browser_not_revoked')
    need(not r['tenMinuteContinuousPlaybackAccepted'] and not r['fullBrowserAccepted'] and not r['releaseAccepted'],'unmeasured_scope_claimed')
    return round(closed['at']-logout,3)

def validate(path):
    r=json.loads(path.read_bytes());need(re.fullmatch(r'phone-browser-interactions-\d{8}-a[1-9][0-9]*',r['runId']) and path.resolve()==E/(r['runId']+'.json'),'wrong_path')
    need(r.get('sources') and r.get('parents'),'bindings_missing')
    for kind in ('sources','parents'):
        for name,digest in r[kind].items():
            p=(ROOT/name).resolve();need(p.is_relative_to(ROOT) and sha(p.read_bytes())==digest,'binding_changed:'+name)
            if kind=='parents':need(json.loads(p.read_bytes())['status']=='passed','parent_failed')
    parents=[ROOT/v for v in r['parents'] if Path(v).name.startswith('phone-member-media-')]
    observers=[ROOT/v for v in r['parents'] if Path(v).name.startswith('phone-peer-observation-')]
    need(len(parents)==len(observers)==1,'exact_parent_missing')
    parent=json.loads(parents[0].read_bytes());controller_checks(parent)
    seconds=checks(r,parent,json.loads(observers[0].read_bytes()))
    return dict(valid=True,runId=r['runId'],peerRevokedSeconds=seconds,evidenceSha256=sha(path.read_bytes()),releaseAccepted=False)

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--evidence',type=Path,required=True);a=ap.parse_args();print(json.dumps(validate(a.evidence)))
