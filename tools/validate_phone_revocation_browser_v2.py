#!/usr/bin/env python3
"""Validate observed DOM media teardown against the exact server action."""
import argparse, datetime as dt, json, re
from pathlib import Path
from validate_phone_member_revocation import ROOT, E, need, sha, validate as controller_validate

def stamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def checks(r, parent):
    need(r['status']=='passed' and r['observationMethod']=='actual-system-trusted-browser','not_actual_browser')
    need(r['phoneId']==parent['phoneId'] and r['memberLogin']==parent['runId'] and r['mode']==parent['mode'],'wrong_fixture')
    first, before, after=r['first'],r['lastPlaying'],r['firstCleared']
    action=stamp(parent['revocationAt'])
    need(stamp(first['at'])<stamp(before['at'])<=action<stamp(after['at']),'wrong_action_window')
    need(0<stamp(after['at'])-action<=10,'browser_revocation_late')
    need(r['sampleCount']>=20 and 0<r['maximumSampleGapMs']<=1000,'observation_gap')
    for v in (first,before):
        need(v['videoReady']==v['audioReady']==4 and not v['videoPaused'] and not v['audioPaused'] and not v['audioMuted'],'media_not_playing')
        need(v['status']=='已连接' and v['inputState']=='open' and v['inputSent']>=4,'input_not_connected')
        need(v['audioEnergy']>0 and v['decodedFrames']>0,'actual_received_media_missing')
    need(before['videoTime']>first['videoTime'] and before['audioTime']>first['audioTime'] and before['decodedFrames']>first['decodedFrames'] and before['audioEnergy']>first['audioEnergy'],'media_not_progressing')
    need(after['videoReady']==after['audioReady']==0 and after['videoPaused'] and after['audioPaused'] and after['videoTime']==after['audioTime']==0,'media_not_cleared')
    need(after['inputStatsCleared'],'input_not_cleared')
    if r['mode']=='stop':need(after['status']=='连接已断开','ui_not_disconnected')
    else:
        need(after['status']=='暂时无法连接手机，请重试。','disable_not_reported')
        # Media/input must stop within ten seconds. Returning to the phone list
        # is a separate UI refresh and is not the security revocation signal.
        settled=r['settled']
        need(settled['workspaceHidden'] and settled['videoReady']==settled['audioReady']==0 and settled['videoPaused'] and settled['audioPaused'],'disabled_workspace_not_closed')
        need(stamp(after['at'])<=stamp(settled['at'])<=action+30,'disabled_list_refresh_late')
    need(not r['fullBrowserAccepted'] and not r['releaseAccepted'],'scope_expanded')
    return round(stamp(after['at'])-action,3)

def validate(path):
    r=json.loads(path.read_bytes());rid=r['runId']
    need(re.fullmatch(r'phone-member-revocation-browser-\d{8}-a[1-9][0-9]*',rid) and path.resolve()==E/(rid+'.json'),'wrong_path')
    need(r.get('sources') and len(r.get('parents',{}))==1,'bindings_missing')
    for group in ('sources','parents'):
        for name,digest in r[group].items():
            p=(ROOT/name).resolve();need(p.is_relative_to(ROOT) and sha(p.read_bytes())==digest,'binding_changed:'+name)
    parent_path=ROOT/next(iter(r['parents']));controller_validate(parent_path)
    seconds=checks(r,json.loads(parent_path.read_bytes()))
    return dict(valid=True,runId=rid,browserClearedWithinSeconds=seconds,evidenceSha256=sha(path.read_bytes()),releaseAccepted=False)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))
