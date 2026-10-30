"""Read-only checks of an isolated candidate run; never claims production rollout."""
import argparse, hashlib, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def sha(raw):return hashlib.sha256(raw).hexdigest()
def validate(path):
 v=json.loads(path.read_bytes())
 assert path.name==v['runId']+'.json' and v['status']=='passed'
 assert v['deployed'] is False and v['productAccepted'] is False and v['contentRetained'] is False
 assert sha((ROOT/'tools/run_flux_resource_candidate_test.py').read_bytes())==v['sourceSha256']
 parent=ROOT/v['build'];assert sha(parent.read_bytes())==v['buildSha256']
 b=json.loads(parent.read_bytes());assert b['status']=='passed' and b['kind']=='flux' and b['image']==v['image']
 assert b['tests']['passed'] and b['tests']['skipped']==0 and b['tests']['tests']>=3
 for f,h in b['sources'].items():assert sha((ROOT/f).read_bytes())==h
 assert v['admission']['availableBytes']>=96*2**30
 assert v['runtime']==dict(image=v['image'],memory=80*2**30,reservation=32*2**30,oom=False)
 assert v['probe']['phase']=='complete' and v['probe']['unloaded'] is True
 for kind in ('generation','edit'):
  o=v['probe'][kind];assert o['width']==o['height']==512 and o['bytes']>1000 and o['variance']>=80
  assert len(o['sha256'])==64 and int(o['sha256'],16)>=0
 assert v['candidateRemoved'] and v['restored'] and not v.get('cleanupFailure') and not v.get('restoreFailures')
 assert len(v['before'])==len(v['drained'])==len(v['after'])==7
 assert len({c['id'] for c in v['before']})==7
 for a,d,b in zip(v['before'],v['drained'],v['after']):
  assert a['id']==b['id']==d['id'] and a['image']==b['image']==d['image']
  assert not d['running'] and a['running'] and b['running'] and a['network']==b['network']
  assert a['health']!='healthy' or b['health']=='healthy'
 assert v['mainBefore']==v['mainAfter'] and len(v['mainBefore'])==6
 assert v['phonesBefore']==v['phonesAfter']
 return dict(status='passed',runId=v['runId'],evidenceSha256=sha(path.read_bytes()),deployed=False,productAccepted=False)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args()
 print(json.dumps(validate(a.evidence)))
