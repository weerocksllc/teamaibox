"""Read-only verification of page/theme/locale/viewport checks, not business QA."""
import argparse,hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def need(v,message):
 if not v:raise RuntimeError(message)
def validate(path):
 r=json.loads(path.read_bytes());need(re.fullmatch('current-page-matrix-20260916-a[1-9][0-9]*',r['runId']),'wrong_run')
 need(path.resolve()==ROOT/'evidence/validation/browser'/(r['runId']+'.json'),'wrong_path')
 need(r['status']=='passed' and not r['failures'] and len(r['rows'])==432,'matrix_failed')
 need(r['systemTrustUsed'] and not r['certificateBypassed'] and not r['userMediaSaved'] and not r['allBusinessJourneysTested'],'scope_changed')
 need(r['cleanup']==dict(memberDisabled=True,ownerPreferencesRestored=True),'cleanup_failed')
 need(r['sourceSha256']==hashlib.sha256((ROOT/'tools/test_current_page_matrix.mjs').read_bytes()).hexdigest(),'source_changed')
 seen=set()
 for v in r['rows']:
  key=(v['role'],v['width'],v['locale'],v['theme'],v['route']);need(key not in seen and v['status']=='passed','duplicate_or_failed');seen.add(key)
  for m in [v['host'],*([v['plugin']] if 'plugin' in v else [])]:
   need(m['locale']==v['locale'] and m['theme']==v['theme'] and m['scrollWidth']<=m['width']+2,'visual_contract_failed')
 return dict(valid=True,runId=r['runId'],checks=len(seen),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),allBusinessJourneysTested=False)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--evidence',required=True,type=Path);a=p.parse_args();print(json.dumps(validate(a.evidence)))
