"""Verify real timer, invitation refusal and logout cleanup, not Apple streaming."""
import argparse,datetime as dt,hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHECKS={'startRealSixtySecondSession','existingOwnerExplicitlyJoined','declinedInvitationCannotJoin','realTimerExpiresAndClearsUI','expiredViewersCleared','expiredSessionRejectsJoin','freshReceiverAfterExpiry','ownerSignOutStopsReceiver'}
def need(v,m):
    if not v:raise RuntimeError(m)
def millis(v):return dt.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()*1000
def validate(path):
    r=json.loads(path.read_bytes())
    need(re.fullmatch(r'casting-expiry-browser-20260916-a[1-9][0-9]*',r['runId']) and path.resolve()==ROOT/'evidence/validation/browser'/(r['runId']+'.json'),'path_invalid')
    need(r['status']=='passed' and not r.get('failure'),'run_failed')
    need(set(r['checks'])==CHECKS and all(r['checks'].values()),'coverage_missing')
    need(r['systemTrustUsed'] and not any(r[k] for k in ('appleSenderAccepted','mediaSaved','clockModified')),'scope_invalid')
    need(len(r['identities'])==1 and r['cleanup']['disabled']==r['identities'] and r['cleanup']['sessionStopped'],'cleanup_failed')
    need(millis(r['expiresAt'])-millis(r['createdAt'])==60000 and 0<=millis(r['expiryObservedAt'])-millis(r['expiresAt'])<15000,'timer_not_measured')
    need(r['expiredJoinStatus'] in (403,404,409,410) and r['sessionId']!=r['successorSessionId'],'expiry_failed')
    need(r['sourceSha256']==hashlib.sha256((ROOT/'tools/test_current_casting_expiry_browser_v2.mjs').read_bytes()).hexdigest(),'source_changed')
    return dict(valid=True,runId=r['runId'],sha256=hashlib.sha256(path.read_bytes()).hexdigest(),checks=len(CHECKS),appleSenderAccepted=False)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))
