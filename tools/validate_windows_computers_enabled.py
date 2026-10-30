"""Read-only deployed configuration and retained-workload check."""
import argparse,json,re
import appliance_container_operations as d
def validate(path):
 r=json.loads(path.read_bytes())
 d.need(re.fullmatch(r'windows-computers-enable-\d{8}-a[1-9]\d*',r['runId']) and path.resolve()==d.ROOT/'evidence/validation/feature-deployments'/(r['runId']+'.json'),'invalid_identity')
 d.need(r['status']=='passed' and not r.get('failure') and not r.get('signOutFailed'),'enable_failed')
 for f,h in {**r['sources'],**r['parents']}.items():d.need(d.sha((d.ROOT/f).read_bytes())==h,'input_changed')
 d.need(r['servicesBefore']==r['servicesAfter'] and r['phonesBefore']==r['phonesAfter'],'workload_changed')
 d.need(all(r[k] is False for k in ['guestsRestarted','browserAccepted','windowsProductAccepted']),'overclaim')
 c=d.inspect(d.MAIN,r['api']);old=d.inspect(d.MAIN,r['oldApi'])
 d.need(d.healthy(d.MAIN,r['api']) and c['Image']==r['image'] and not old['State']['Running'],'api_drift')
 config=json.loads(d.env(c)['PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON']);previous=json.loads(d.env(old)['PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON'])
 d.need(config=={**previous,'enabled':True},'unrelated_configuration_changed')
 p=d.sql("SELECT row_to_json(t) FROM (SELECT profile,create_enabled FROM platform.computer_profiles WHERE id='windows-11-arm64-25h2')t")
 d.need(p==dict(profile=r['profile'],create_enabled=True),'profile_changed')
 for host,services in r['servicesAfter'].items():
  current={v['Id']:v for v in json.loads(d.run(host,['docker','inspect',*[x['id'] for x in services]]))}
  for x in services:
   v=current[x['id']];d.need(v['State']['Running'] and v['Image']==x['image'] and v['State']['StartedAt']==x['startedAt'],'unrelated_service_drift')
 d.need(d.phones()==r['phonesAfter'],'phones_changed')
 return dict(valid=True,runId=r['runId'],evidenceSha256=d.sha(path.read_bytes()),creationEnabled=True,windowsProductAccepted=False)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--evidence',required=True);a=p.parse_args();print(json.dumps(validate(d.ROOT/a.evidence)))
