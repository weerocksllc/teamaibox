"""Strict read-only validation; health is not full application acceptance."""
import argparse,json,re
import appliance_container_operations as d
def validate(path):
 r=json.loads(path.read_bytes())
 d.need(re.fullmatch(r'retained-runtime-recovery-\d{8}-a[1-9]\d*',r['runId']) and path.resolve()==d.ROOT/'evidence/validation/feature-deployments'/(r['runId']+'.json'),'invalid_identity')
 d.need(r['status']=='passed' and not r.get('failure') and not r.get('rollbackFailures'),'deployment_failed')
 for f,h in r['sources'].items():d.need(d.sha((d.ROOT/f).read_bytes())==h,'source_changed')
 for f,h in r['builds'].items():
  d.need(d.sha((d.ROOT/f).read_bytes())==h,'build_changed');b=json.loads((d.ROOT/f).read_bytes())
  d.need(b['status']=='passed' and all(d.sha((d.ROOT/s).read_bytes())==v for s,v in b['sources'].items()),'build_source_changed')
 d.need(r['servicesBefore']==r['servicesAfter'] and r['phonesBefore']==r['phonesAfter'],'workload_changed')
 d.need(all(r[k] is False for k in ['workloadsRestarted','hostRebooted','windowsProductAccepted']),'overclaim')
 d.need(r['nodeBefore']==r['nodeAfter'] and r['protocol']['generation']==r['nodeAfter']['generation'] and r['protocol']['staleEnvelopeRejected'],'generation_failed')
 expected={w['workerId']:w for w in r['workers']};actual={v['workerId']:v for v in r['protocol']['results']}
 d.need(len(expected)==len(r['workers'])==len(actual) and set(expected)==set(actual),'missing_runtime')
 for k,w in expected.items():
  v=actual[k];d.need(v['containerId']==w['containerId'] and v['health'] in ['healthy','not_configured'],'runtime_unhealthy')
  if w['path']:d.need(v['application']['status']==200 and v['application']['bytes']>0,'page_failed')
 for e in r['deployments']:
  c=d.inspect(d.MAIN,e['containerId']);old=d.inspect(d.MAIN,e['old'])
  d.need(c['Image']==e['image'] and d.healthy(d.MAIN,c['Id']) and not old['State']['Running'],'deployment_drift')
 for w in r['servicesAfter']:
  c=d.inspect(d.MAIN,w['id']);d.need(c['Image']==w['image'] and c['State']['StartedAt']==w['startedAt'] and c['State']['Running'],'unrelated_service_drift')
 d.need(d.phones()==r['phonesAfter'],'phones_changed')
 api=next(e['containerId'] for e in r['deployments'] if e['kind']=='api')
 source=(d.ROOT/'tools/probe_retained_runtime.mjs').read_text().replace("from '../","from '/opt/teamaibox/")
 source+='\nconsole.log(JSON.stringify(await probe('+json.dumps(r['workers'])+','+str(r['nodeAfter']['generation'])+')))\n'
 live=json.loads(d.run(d.MAIN,['docker','exec','-i',api,'node','--input-type=module'],input=source.encode(),timeout=180))
 d.need(live==r['protocol'],'live_protocol_drift')
 return dict(valid=True,runId=r['runId'],evidenceSha256=d.sha(path.read_bytes()),runtimeCount=len(expected),workloadsRestarted=False)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--evidence',required=True);a=p.parse_args();print(json.dumps(validate(d.ROOT/a.evidence)))
