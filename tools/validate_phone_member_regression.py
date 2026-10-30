#!/usr/bin/env python3
"""Strict checks for bounded member/API/browser observations, never a release gate."""
import argparse,json,re
from pathlib import Path
from appliance_operations import ROOT,need
from appliance_operations import sha

def validate_record(r,path):
    path=path.resolve();rid=r['runId']
    need(re.fullmatch(r'phone-(?:member-(?:transfers|adb|denials|browser|ui-observations|lifecycle)|peer-observation)-\d{8}-a[1-9][0-9]*',rid),'invalid_run')
    need(path==ROOT/'evidence/validation/virtual-phones'/(rid+'.json'),'path_changed')
    need(r['status']=='passed' and r.get('failure') is None and not r.get('cleanupFailures'),'run_not_passed')
    if not rid.startswith('phone-peer-observation-'):
        need(bool(r.get('sources')) and bool(r.get('parents')),'bindings_missing')
        parent_names=[Path(f).name for f in r['parents']]
        required=('phone-member-browser-','phone-peer-observation-','phone-member-transfers-','phone-ui-protocol-install-') if rid.startswith('phone-member-ui-observations-') else ('phone-platform-',)
        need(all(any(name.startswith(prefix) for name in parent_names) for prefix in required),'parent_kind_missing')
        if not rid.startswith('phone-member-ui-observations-'):
            node_kinds=('phone-peer-node-','phone-memory-node-','phone-cleanup-node-') if rid.startswith('phone-member-lifecycle-') else ('phone-peer-node-',)
            need(any(name.startswith(node_kinds) for name in parent_names),'node_parent_missing')
    need(not r.get('releaseAccepted') and not r.get('fullBrowserAccepted'),'release_claim_expanded')
    for kind in ('sources','parents'):
        for f,digest in r.get(kind,{}).items():
            p=(ROOT/f).resolve();need(p.is_relative_to(ROOT) and sha(p.read_bytes())==digest,'bound_file_changed:'+f)
            if kind=='parents':need(json.loads(p.read_bytes())['status']=='passed','parent_not_passed:'+f)
    if rid.startswith('phone-member-transfers-'):
        need(len(r['uploads'])==2 and all(v['foreignOwnerDenied'] for v in r['uploads']),'uploads_incomplete')
        text,apk=r['uploads'];need(text['result']['phoneId']==apk['result']['phoneId']==r['phoneId'],'phone_changed')
        need(text['sha256']==r['export']['sha256']==sha((ROOT/'tools/fixtures/phone-transfer-app/member-browser-a3.txt').read_bytes()),'file_bytes_changed')
        need(apk['sha256']==sha((ROOT/'tools/fixtures/phone-transfer-app/phone-fixture-v1.apk').read_bytes()) and apk['result']['installed'] is True,'apk_not_installed')
        need(set(r['checks'])=={'foreignPhoneDenied','memberNotAdmin','exactDownloadBytes','phoneRemainsRunning'} and all(v is True for v in r['checks'].values()),'transfer_checks_missing')
    elif rid.startswith('phone-member-lifecycle-'):
        cycles=r['cycles'];need([v['cycle'] for v in cycles]==list(range(1,11)),'ten_cycles_missing')
        need([v['generation'] for v in cycles]==list(range(1,11)),'generations_changed')
        need(len({v['run']['id'] for v in cycles})==10,'run_reused')
        expected=sha((ROOT/'tools/fixtures/phone-transfer-app/member-browser-a3.txt').read_bytes())
        for v in cycles:
            need(v['appDataVerified'] is True and v['fileSha256']==expected,'data_not_preserved')
            need(v['run']['generation']==v['generation'] and v['run']['state']=='stopped' and v['run']['cleanShutdown'] is True,'unclean_shutdown')
            need(0<v['startSeconds']<240 and 0<v['stopSeconds']<100,'cycle_timeout')
        need(r['phoneDeleted'] is True and r['identityDisabled'] is True,'fixture_not_cleaned')
        need(r['policyBefore']==r['policyAfter'],'policy_changed')
        if any('tools/qualify_phone_member_lifecycle_v'+v+'.py' in r['sources'] for v in ('2','3','4')):
            need('foreignBefore' in r and r['foreignBefore']==r.get('foreignAfter'),'other_user_phone_changed')
        if any('tools/qualify_phone_member_lifecycle_v'+v+'.py' in r['sources'] for v in ('3','4')):
            observations=r['shutdownObservations']
            need([v['cycle'] for v in observations]==list(range(1,11)),'shutdown_observations_missing')
            for cycle,v in zip(cycles,observations):
                c,s=v['container'],v['status']
                need(v['run']==cycle['run'] and s['phoneId']==r['phoneId'] and s['ownerId']==r['identityId'] and s['runId']==cycle['run']['id'] and s['generation']==cycle['generation'],'shutdown_observation_identity_changed')
                need(not c['running'] and c['exitCode']==0 and not c['oom'] and s['phase']=='stopped' and s['cleanShutdown'] is True and s.get('errorCode') is None,'runtime_shutdown_not_clean')
                need(all(s['shutdownEvidence'].get(k) is True for k in ('syncCompleted','androidShutdownRequested','guestExitedBeforeRuntimeStop')),'guest_shutdown_proof_missing')
                if 'tools/qualify_phone_member_lifecycle_v4.py' in r['sources']:
                    attempts=s['shutdownDiagnostics']['runtimeCleanup']
                    need(1<=len(attempts)<=3 and attempts[-1].get('exitCode')==0 and attempts[-1].get('remainingGuestProcesses')==0,'runtime_cleanup_not_confirmed')
        current={v['id']:v for v in r['nodeAfter']}
        need(bool(r['nodeBefore']) and all(current.get(v['id'])==v for v in r['nodeBefore']) and r['mainBefore']==r['mainAfter'],'old_services_changed')
        need(all(r[k] is False for k in ('hostRebooted','agentRestarted','platformRestarted')),'restart_claim_changed')
    elif rid.startswith('phone-member-adb-'):
        checks=r['checks'];need([x['action'] for x in checks]==['explicit','expiry','signout'],'adb_cases_missing')
        for x in checks:
            need(x['standardAdbRead'] and x['actualAdbRejectedAfterClose'] and x['loopbackListenerClosed'],'adb_not_observed')
            limit=x['ttlSeconds']+10 if x['action']=='expiry' else 10
            need(0<=x['closeSeconds']<limit and 1<=x['ttlSeconds']<=900,'adb_timing_failed')
        need(checks[0]['appDataVerified'],'app_data_not_verified')
    elif rid.startswith('phone-member-denials-'):
        checks=r['checks'];need(checks['foreignOwnerAdbDenied'] and checks['excessiveTtlDenied'],'http_denials_missing')
        for key in ('defaultClosed','wrongTicketDenied','wrongPhoneDenied'):
            need(checks[key]==dict(noLoopbackListener=True,processExited=True),'wss_denial_missing')
    elif rid.startswith('phone-member-browser-'):
        need(len(r['identities'])==2 and all(x['roles']==['member'] for x in r['identities']),'members_missing')
        latest=r['checks'][-1];need(len(latest['phones'])==2 and all(p['state']=='running' for p in latest['phones']) and latest['foreignOwnerDenied'],'pair_missing')
        need(set(r['cleanedPhones'])=={p['id'] for p in latest['phones']} and r['nodeBefore']==r['nodeAfter'] and r['mainBefore']==r['mainAfter'],'cleanup_changed')
        need(r['featureRestored'] and r['browserAccepted'] is False and r['memberAccepted'] is False,'fixture_claim_expanded')
    elif rid.startswith('phone-member-ui-observations-'):
        need(r['observationMethod']=='actual-system-trusted-browser' and r['reloadCount']==10,'browser_not_observed')
        need([v['cycle'] for v in r['reloads']]==list(range(1,11)),'reloads_missing')
        for value in [*r['reloads'],r['secondPhoneVideo']]:
            need(value['width']==720 and value['height']==1280 and value['ready']==4 and value['time']>0 and value['paused'] is False,'decoded_video_missing')
        need(r['pointerUnlockObserved'] and r['fileUploadObserved'] and r['fileDownloadObserved'],'ui_checks_missing')
        need(r['tenMinuteContinuousPlaybackAccepted'] is False and r['fullBrowserAccepted'] is False,'unmeasured_playback_claimed')
    elif rid.startswith('phone-peer-observation-'):
        need(r['sourceSha256']==sha((ROOT/'tools/observe_phone_peer.py').read_bytes()) and r['readOnly'] and r['exitCode']==0,'observer_changed')
        samples=r['samples'];need(len(samples)==300 and samples[-1]['at']-samples[0]['at']>=595,'observation_incomplete')
        need(all(v['android']==samples[0]['android'] and v['streamer']==samples[0]['streamer'] and not v.get('error') for v in samples),'process_changed')
        need(all(v['memory.swap.current']==0 and v['memory.peak']<=6*1024**3 for v in samples),'memory_failed')
    else:raise RuntimeError('unsupported_evidence_kind')
    return rid

def validate(path):
    rid=validate_record(json.loads(path.read_bytes()),path)
    return dict(valid=True,runId=rid,evidenceSha256=sha(path.read_bytes()),releaseAccepted=False)

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--evidence',type=Path,required=True);a=ap.parse_args();print(json.dumps(validate(a.evidence)))
