"""Create three disposable member phones; preserve all pre-existing phones."""
import argparse,datetime as dt,json,re,sys,time
from pathlib import Path
from upgrade_phone_ui_protocol import Session
import appliance_container_operations as d

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);a=p.parse_args();rid=a.run_id
    d.need(re.fullmatch(r'phone-resource-count-probe-\d{8}-a[1-9]\d*',rid),'invalid_run')
    path=d.ROOT/'evidence/validation/virtual-phones'/(rid+'.json');d.need(not path.exists(),'run_occupied')
    credential=json.loads(sys.stdin.readline());s=Session();owned=[]
    before=d.phones();r=dict(runId=rid,status='failed',sources={str(Path(__file__).relative_to(d.ROOT)):d.sha(Path(__file__).read_bytes())},phonesBefore=before,created=[],calls=s.calls)
    def operation(op):
        until=time.monotonic()+360
        while op['state'] in ('queued','executing'):
            d.need(time.monotonic()<until,'operation_timeout')
            time.sleep(3);op=s.request('/api/v1/virtual-phones/operations/'+op['id'])
        d.need(op['state']=='succeeded','operation_failed_'+str(op.get('errorCode')))
        return op
    def action(phone,verb):
        row=s.request('/api/v1/virtual-phones/'+phone)
        body={'expectedRevision':row['revision']}
        if verb=='delete':body['confirmDelete']=True
        return operation(s.request('/api/v1/virtual-phones/'+phone+('/'+verb if verb!='delete' else ''),body,method='DELETE' if verb=='delete' else 'POST',key=rid+'-'+phone+'-'+verb))
    try:
        login=s.request('/api/auth/sign-in',credential);credential=None;s.csrf=login['csrfToken'];login=None
        initial=s.request('/api/v1/virtual-phones');r['quota']=initial['quota']
        d.need(r['quota']['storedPerUser'] is None and r['quota']['runningPerUser'] is None,'quota_not_resource_based')
        for i in range(3):
            op=s.request('/api/v1/virtual-phones',{'name':'资源规则临时测试 '+str(i+1),'start':False,'romVersionId':'aosp-camera-17-16102939-resource2'},key=rid+'-create-'+str(i))
            owned.append(op['phoneId']);r['created'].append(operation(op))
        r['afterCreate']=s.request('/api/v1/virtual-phones')['quota'];d.need(r['afterCreate']['stored']==initial['quota']['stored']+3,'stored_count_mismatch')
        # One existing guest plus two new guests exercises instance 23, which
        # the old two-slot runtime could not allocate. No office drain allowed.
        r['boots']=[]
        for index,phone in enumerate(owned[:2]):
            if index:
                # The admission policy requires a quiet 30-second host window.
                # Do not test the next boot inside the prior boot's pressure peak.
                time.sleep(35)
            r['boots'].append(action(phone,'start'))
        r['running']=s.request('/api/v1/virtual-phones')['quota']
        d.need(r['running']['running']==initial['quota']['running']+2,'running_count_mismatch')
        r['allocations']=d.sql("SELECT json_agg(x) FROM (SELECT phone_id,generation,container_id FROM platform.phone_runs WHERE phone_id IN ('"+"','".join(owned)+"') AND state='running')x")
        r['status']='passed'
    except Exception as e:r['failure']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
    finally:
        credential=None;r['cleanup']=[]
        for phone in reversed(owned):
            try:
                row=s.request('/api/v1/virtual-phones/'+phone)
                if row['runningCharged']:action(phone,'stop')
                r['cleanup'].append(action(phone,'delete'))
            except Exception as e:r.setdefault('cleanupErrors',[]).append(type(e).__name__);r['status']='failed'
        r['phonesAfter']=d.phones()
        if r['phonesAfter']!=before:r['status']='failed';r['existingPhonesChanged']=True
        if s.csrf:
            try:s.request('/api/auth/sign-out',{})
            except Exception:r['status']='failed'
        r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
        with path.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps({k:r.get(k) for k in ['runId','status','failure','cleanupErrors']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
