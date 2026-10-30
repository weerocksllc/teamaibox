#!/usr/bin/env python3
"""Validate actual peer-socket revocation separately from browser observations."""
import argparse,json,re
from pathlib import Path
from appliance_operations import ROOT,need
from appliance_operations import sha
E=ROOT/'evidence/validation/virtual-phones'

def checks(r):
    need(r['status']=='passed' and r['failure'] is None and r['cleanupFailures']==[],'run_failed')
    need(r['mode'] in ('stop','disable'),'wrong_mode')
    need(r['phoneDeleted'] and r['identityDisabled'],'cleanup_missing')
    need(r['policyBefore']==r['policyAfter'] and r['oldServiceIdentityUnchanged'] and r['foreignStateUnchanged'],'user_or_service_changed')
    c=r['runtimeBefore']
    need(c['running'] and c['memory']==c['swapLimit']==6*1024**3,'runtime_limit_changed')
    need(c['labels']['com.teamaibox.phone-id']==r['phoneId'] and c['labels']['com.teamaibox.owner-identity-id']==r['identityId'],'wrong_runtime')
    need(r['installation']['installed'] is True,'apk_not_installed')
    v=r['sourceBeforeRevocation'];need(v['audioPlaying'] and v['audioFramesPlayed']>0 and v['drawnFrames']>0,'source_not_playing')
    samples=r['peerObservations'];need(len(samples)>=2 and samples[0]['peersGone'] is False and samples[-1]['peersGone'] is True,'actual_peer_revocation_missing')
    need(not any('error' in v for v in samples) and 0<r['peerRevokedSeconds']<=10,'revocation_failed_or_late')
    if r['mode']=='disable':need(r['revocationResult']['status']=='disabled' and r['reenabledOnlyForCleanup'] is True,'disable_not_proven')
    need(r['browserAccepted'] is False and not r['hostRebooted'] and not r['servicesRestarted'],'scope_expanded')

def validate(path):
    r=json.loads(path.read_bytes());rid=r['runId']
    need(re.fullmatch(r'phone-member-revocation-\d{8}-a[1-9][0-9]*',rid) and path.resolve()==E/(rid+'.json'),'wrong_path')
    need(r.get('sources') and r.get('parents'),'bindings_missing')
    for group in ('sources','parents'):
        for name,digest in r[group].items():
            p=(ROOT/name).resolve();need(p.is_relative_to(ROOT) and sha(p.read_bytes())==digest,'binding_changed:'+name)
            if group=='parents':need(json.loads(p.read_bytes())['status']=='passed','parent_failed')
    checks(r)
    return dict(valid=True,runId=rid,evidenceSha256=sha(path.read_bytes()),browserAccepted=False,releaseAccepted=False)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))
