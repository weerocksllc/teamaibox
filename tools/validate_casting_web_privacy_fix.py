#!/usr/bin/env python3
"""Correct the deployment checker count (13 actual tests), without rerunning or rewriting a4."""
import argparse
import json
from pathlib import Path
from deploy_casting_web_privacy_fix import ROOT, SOURCES, SOURCE, PARENT, OLD, RUN, need, preamble, remote, bindings, digest, canonical

def validate(path):
    v=json.loads(path.read_bytes());sig=v.pop('evidenceDigest');o=v['result']
    need(RUN.fullmatch(v['runId']) and path==ROOT/'evidence/validation/feature-deployments'/(v['runId']+'.json'),'path_invalid')
    need(sig==digest(canonical(v)) and v['status']==o['status']=='passed' and v['sources']==bindings(SOURCES),'evidence_changed')
    tap=v['tests']['output']
    need(v['tests']['exitCode']==0 and '# tests 13\n' in tap and '# pass 13\n' in tap and '# fail 0\n' in tap
         and '# skipped 0\n' in tap and 'casting signalling handles never enter HTTP or WebSocket request logs' in tap
         and v['tests']['digest']==digest(tap.encode()),'tests_failed')
    need(o['parent']['containerId']==PARENT and o['parent']['imageId']==OLD and o['protectedBefore']==o['protectedAfter']
         and v['productAccepted'] is False and v['browserAccepted'] is False,'identity_or_claim_changed')
    live=remote(preamble()+"print(json.dumps(dict(current=r.facts(r.inspect(web)),protected=protected(),oldRunning=r.inspect("+repr(PARENT)+")[ 'State']['Running'],checks=check(r.inspect(web)['Id']))))\n",45)
    need(live['current']==o['web']['current'] and live['protected']==o['protectedAfter'] and not live['oldRunning']
         and live['checks']==o['web']['checks'] and live['checks']['source']==v['sources'][SOURCE],'live_changed')
    return dict(status='passed',runId=v['runId'],evidenceDigest=sig,checkerSourceDigest=digest(Path(__file__).read_bytes()),
                correctedCheckerCount=13,productAccepted=False,browserAccepted=False)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);a=p.parse_args()
    print(json.dumps(validate(a.evidence.resolve())))
