"""Strict scope check for current synthetic member browser collaboration journeys."""
import argparse,hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHECKS={'memberSelectedRecipient','liveMessageAndAttachmentReceived','attachmentDownloadIntegrity','liveReply',
 'conversationIsolation','messageReloadPersistence','groupMessage','folderCreated','filenamePreserved','filePreview',
 'fileDownloadIntegrity','fileVersionHistory','renameAndLatestVersion','privateFileIsolation','trashAndRestore','fileReloadPersistence'}
def need(value,message):
 if not value:raise RuntimeError(message)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def validate(path):
 r=json.loads(path.read_bytes());need(re.fullmatch(r'current-collaboration-browser-20260916-a[1-9][0-9]*',r['runId']),'run_invalid')
 need(path.resolve()==ROOT/'evidence/validation/browser'/(r['runId']+'.json'),'path_invalid')
 need(r['status']=='passed' and not r.get('failure'),'journey_failed')
 need(set(r['checks'])==CHECKS and all(r['checks'].values()),'checks_missing')
 need(r['systemTrustUsed'] and r['syntheticOnly'] and not r['allBusinessJourneysTested'],'scope_invalid')
 need(len(r['identities'])==len(set(r['identities']))==3 and r['cleanup']['disabled']==r['identities'],'cleanup_failed')
 need(r['cleanup']['syntheticRecordsRetained'],'retention_scope')
 need(r['sourceSha256']==sha(ROOT/'tools/test_current_collaboration_browser_v3.mjs'),'runner_changed')
 need(len(r['parents'])==4,'parents_missing')
 for p,d in r['parents'].items():need(sha(ROOT/p)==d and json.loads((ROOT/p).read_bytes())['status']=='passed','parent_changed')
 need(all(r[k] in (403,404) for k in ('outsiderMessageStatus','outsiderFileStatus')),'isolation_failed')
 for k in ('conversationId','fileId'):need(re.fullmatch(r'[a-f0-9-]{36}',r[k]),'identity_invalid')
 for k in ('attachment','file'):need(re.fullmatch(r'[a-f0-9]{64}',r[k]['sha256']) and r[k]['name']==r['runId']+'.txt','download_invalid')
 return dict(valid=True,runId=r['runId'],sha256=sha(path),checks=len(CHECKS),allBusinessJourneysTested=False)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();print(json.dumps(validate(a.evidence)))

