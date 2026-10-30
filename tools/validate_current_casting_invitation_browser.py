"""Validate actual installed casting invitation controls, not Apple audio/video."""
import argparse, hashlib, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHECKS={'initiatorAutoJoined','workbenchInvitationVisibleOnlyToRecipient','invitationRequiresAcceptance','acceptedMemberJoined','uninvitedMemberDenied','voluntaryLeaveNotAutoRejoined','initiatorRemovalDisconnectsViewer','stopClearsPairingState'}
def need(value,message):
    if not value: raise RuntimeError(message)
def validate(path):
    r=json.loads(path.read_bytes())
    need(re.fullmatch(r'casting-invitation-browser-20260916-a[1-9][0-9]*',r['runId']),'run_invalid')
    need(path.resolve()==ROOT/'evidence/validation/browser'/(r['runId']+'.json'),'path_invalid')
    need(r['status']=='passed' and not r.get('failure'),'run_failed')
    need(set(r['checks'])==CHECKS and all(r['checks'].values()),'checks_missing')
    need(r['systemTrustUsed'] and not any(r[k] for k in ('appleSenderAccepted','pictureAudioAccepted','userMediaSaved')),'scope_invalid')
    need(len(r['identities'])==len(set(r['identities']))==2 and r['cleanup']['disabled']==r['identities'] and r['cleanup']['sessionStopped'],'cleanup_failed')
    need(r['outsiderStatus'] in (403,404),'isolation_failed')
    need(re.fullmatch(r'[a-f0-9-]{36}',r['sessionId']),'session_invalid')
    need(r['sourceSha256']==hashlib.sha256((ROOT/'tools/test_current_casting_invitation_browser_v3.mjs').read_bytes()).hexdigest(),'source_changed')
    return dict(valid=True,runId=r['runId'],sha256=hashlib.sha256(path.read_bytes()).hexdigest(),checks=len(CHECKS),appleSenderAccepted=False,pictureAudioAccepted=False)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))
