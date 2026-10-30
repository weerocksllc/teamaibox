import os
import argparse,datetime as dt,json,re
import appliance_container_operations as d
API=os.environ.get('TEAMAIBOX_RUN_OBJECT_RPC_RESOURCE_PROBE_API')
OBJECT=os.environ.get('TEAMAIBOX_RUN_OBJECT_RPC_RESOURCE_PROBE_OBJECT')
def main():
 p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);RUN=p.parse_args().run_id
 if not re.fullmatch(r'object-rpc-resource-probe-\d{8}-a[1-9]\d*',RUN):raise ValueError('invalid_run_id')
 if API is None:
     raise ValueError('explicit_TEAMAIBOX_RUN_OBJECT_RPC_RESOURCE_PROBE_API_required')
 if OBJECT is None:
     raise ValueError('explicit_TEAMAIBOX_RUN_OBJECT_RPC_RESOURCE_PROBE_OBJECT_required')
 out=d.ROOT/'evidence/validation/acceptance'/(RUN+'.json');d.need(not out.exists(),'occupied')
 src=d.ROOT/'tools/probe_object_rpc_resource_admission.mjs'
 r=dict(runId=RUN,status='failed',startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),api=API,object=OBJECT,
        sourceSha256=d.sha(src.read_bytes()),phonesBefore=d.phones())
 try:
  d.need(d.healthy(d.MAIN,API) and d.healthy(d.MAIN,OBJECT),'service_unhealthy')
  r['protocol']=json.loads(d.run(d.MAIN,['docker','exec','-i',API,'node','--input-type=module','-'],input=src.read_bytes(),timeout=90))
  r['phonesAfter']=d.phones();d.need(r['phonesBefore']==r['phonesAfter'],'phones_changed')
  d.need(d.healthy(d.MAIN,OBJECT),'service_unhealthy_after_test');r['status']='passed'
 except Exception as e:r['failure']=str(e)
 r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
 with out.open('x') as f:json.dump(r,f,indent=2)
 print(json.dumps({k:r.get(k) for k in ['runId','status','failure','protocol']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
