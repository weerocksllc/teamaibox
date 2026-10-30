#!/usr/bin/env python3
"""Keep real APK/controller results separate from actual browser observations."""
import argparse,datetime as dt,json,re
from pathlib import Path
from appliance_operations import ROOT,need
from appliance_operations import sha

E=ROOT/'evidence/validation/virtual-phones'
def stamp(v):return dt.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
def controller_checks(r):
    need(r['status']=='passed' and r['failure'] is None and r['cleanupFailures']==[],'run_failed')
    need(r['phoneDeleted'] is True and r['identityDisabled'] is True,'fixture_cleanup_missing')
    need(r['policyBefore']==r['policyAfter'] and r['oldServiceIdentityUnchanged'] and r['foreignStateUnchanged'],'user_or_service_changed')
    need(r['runtimeBefore']==r['runtimeAfter'],'runtime_changed')
    c=r['runtimeBefore'];need(c['running'] and c['memory']==c['swapLimit']==6*1024**3 and c['labels']['com.teamaibox.phone-id']==r['phoneId'] and c['labels']['com.teamaibox.owner-identity-id']==r['identityId'],'wrong_fixture_runtime')
    need(r['installation']['installed'] is True and r['apkObject']['sha256']==sha((ROOT/'tools/fixtures/phone-media-app/phone-media-fixture-v2.apk').read_bytes()),'apk_missing')
    samples=r['samples'];need(len(samples)>=40,'samples_missing')
    need(stamp(samples[-1]['observedAt'])-stamp(samples[0]['observedAt'])>=600,'ten_minutes_missing')
    for a,b in zip(samples,samples[1:]):
        need(0<stamp(b['observedAt'])-stamp(a['observedAt'])<=22,'observation_gap')
        need(b['elapsedMs']>a['elapsedMs'] and b['drawnFrames']>a['drawnFrames'] and b['audioFramesPlayed']>a['audioFramesPlayed'],'fixture_stalled')
    need(all(v['audioPlaying'] and v['audioWrittenSamples']==96000 and v['width']==720 and v['height']==1280 for v in samples),'source_media_missing')
    need(samples[-1]['touches']>0 and samples[-1]['keys']>0,'actual_input_missing')
    need(r['browserAccepted'] is False and not r['hostRebooted'] and not r['servicesRestarted'],'controller_scope_expanded')

def browser_checks(r,parent):
    need(r['status']=='passed' and r['observationMethod']=='actual-system-trusted-browser','browser_not_passed')
    need(r['phoneId']==parent['phoneId'] and r['memberLogin']==parent['runId'],'wrong_member_or_phone')
    samples=r['samples'];need(len(samples)>=12,'browser_samples_missing')
    duration=stamp(samples[-1]['at'])-stamp(samples[0]['at']);need(duration>=600,'ten_minutes_missing')
    for a,b in zip(samples,samples[1:]):
        need(0<stamp(b['at'])-stamp(a['at'])<=65,'browser_observation_gap')
        for kind in ('video','audio'):need(b[kind]['time']>a[kind]['time'],'playback_stalled')
        for key in ('画面 · 已解码帧','音频 · 收到采样数','音频 · 累计音频能量'):
            need(b['stats'][key]>a['stats'][key],'received_media_stalled')
    for v in samples:
        need(v['video']['width']==720 and v['video']['height']==1280 and v['video']['ready']==4 and v['video']['paused'] is False,'actual_video_missing')
        need(v['audio']['ready']==4 and not v['audio']['paused'] and not v['audio']['muted'],'actual_audio_not_playing')
        need(v['stats']['输入 · 状态']=='open' and v['stats']['输入 · 已发送消息']>=4,'input_channel_missing')
    need(r['automaticConnection'] is True and r['pointerAndKeyboardObserved'] is True,'interaction_missing')
    need(r['endToEndLatencyMeasured'] is False and r['fullBrowserAccepted'] is False and r['releaseAccepted'] is False,'unmeasured_claim')

def validate(path):
    r=json.loads(path.read_bytes());rid=r['runId']
    need(re.fullmatch(r'phone-member-media(?:-browser)?-\d{8}-a[1-9][0-9]*',rid) and path.resolve()==E/(rid+'.json'),'wrong_path')
    need(r.get('sources') and r.get('parents'),'bindings_missing')
    for kind in ('sources','parents'):
        for name,digest in r[kind].items():
            target=(ROOT/name).resolve();need(target.is_relative_to(ROOT) and sha(target.read_bytes())==digest,'binding_changed:'+name)
            if kind=='parents':need(json.loads(target.read_bytes())['status']=='passed','parent_failed')
    if rid.startswith('phone-member-media-browser-'):
        candidates=[ROOT/name for name in r['parents'] if re.fullmatch(r'phone-member-media-\d{8}-a[1-9][0-9]*\.json',Path(name).name)]
        need(len(candidates)==1,'controller_parent_missing');parent=json.loads(candidates[0].read_bytes());controller_checks(parent);browser_checks(r,parent)
    else:controller_checks(r)
    return dict(valid=True,runId=rid,evidenceSha256=sha(path.read_bytes()),releaseAccepted=False)

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--evidence',type=Path,required=True);a=ap.parse_args();print(json.dumps(validate(a.evidence)))
