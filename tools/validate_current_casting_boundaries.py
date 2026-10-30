"""Check installed browser-HTTP casting boundaries without claiming Apple media."""
import argparse,hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHECKS={'rejectRetiredAndMalformedOutputs','startAndIdempotency','secondSessionBusy','updateCannotEnableHDMI','managerDoesNotReceivePairingSecrets','managerCannotSilentlyView','initiatorDisableStopsSession','disabledMemberCannotReuseSession'}
def need(value,message):
    if not value:raise RuntimeError(message)
def validate(path):
    r=json.loads(path.read_bytes());need(re.fullmatch(r'casting-control-boundaries-20260916-a[1-9][0-9]*',r['runId']),'run_invalid')
    need(path.resolve()==ROOT/'evidence/validation/browser'/(r['runId']+'.json'),'path_invalid')
    need(r['status']=='passed' and not r.get('failure'),'run_failed')
    need(set(r['checks'])==CHECKS and all(r['checks'].values()),'checks_missing')
    need(r['systemTrustUsed'] and not r['appleSenderAccepted'] and not r['mediaSaved'],'scope_invalid')
    need(len(r['identities'])==1 and r['cleanup']['disabled']==r['identities'] and r['cleanup']['sessionStopped'],'cleanup_failed')
    need(r['busyCode']=='cast_session_busy','busy_missing')
    need(r['rejectedOutputs']==[dict(value=v,status=400,code='cast_output_invalid') for v in ([],['hdmi'],['browser','hdmi'],['unknown'],None)],'output_rejection_missing')
    need(r['sourceSha256']==hashlib.sha256((ROOT/'tools/test_current_casting_boundaries_v2.mjs').read_bytes()).hexdigest(),'source_changed')
    return dict(valid=True,runId=r['runId'],sha256=hashlib.sha256(path.read_bytes()).hexdigest(),checks=len(CHECKS),appleSenderAccepted=False)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))
