"""Disposable owner phone: >120s mTLS upload and >200-file real Android list."""
import argparse,datetime as dt,json,re,sys,time
from pathlib import Path
from upgrade_phone_ui_protocol import Session
import appliance_container_operations as d

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);rid=p.parse_args().run_id
    d.need(re.fullmatch(r'phone-file-progress-probe-\d{8}-a[1-9]\d*',rid),'invalid_run')
    out=d.ROOT/'evidence/validation/virtual-phones'/(rid+'.json');d.need(not out.exists(),'run_occupied')
    credential=json.loads(sys.stdin.readline());s=Session();owned=None
    parent_path=d.ROOT/'evidence/validation/feature-deployments/phone-file-progress-20260915-a1.json';parent=json.loads(parent_path.read_bytes());d.need(parent['status']=='passed','deployment_failed')
    api=next(v['container'] for v in parent['deployments'] if v['kind']=='api')
    before=d.phones();r=dict(runId=rid,status='failed',sources={f:d.sha((d.ROOT/f).read_bytes()) for f in ['tools/test_phone_file_progress_live.py','tools/probe_phone_file_progress.mjs']},parentSha256=d.sha(parent_path.read_bytes()),phonesBefore=before,calls=s.calls)
    def operation(op):
        until=time.monotonic()+360
        while op['state'] in ('queued','executing'):
            d.need(time.monotonic()<until,'operation_timeout');time.sleep(3);op=s.request('/api/v1/virtual-phones/operations/'+op['id'])
        d.need(op['state']=='succeeded','operation_failed_'+str(op.get('errorCode')));return op
    def action(verb):
        row=s.request('/api/v1/virtual-phones/'+owned);body={'expectedRevision':row['revision']}
        if verb=='delete':body['confirmDelete']=True
        return operation(s.request('/api/v1/virtual-phones/'+owned+('/'+verb if verb!='delete' else ''),body,method='DELETE' if verb=='delete' else 'POST',key=rid+'-'+verb))
    try:
        login=s.request('/api/auth/sign-in',credential);credential=None;s.csrf=login['csrfToken'];login=None
        name='文件传输临时测试 '+rid
        op=s.request('/api/v1/virtual-phones',{'name':name,'start':False,'romVersionId':'aosp-camera-17-16102939-resource3'},key=rid+'-create');owned=op['phoneId'];r['created']=operation(op);r['boot']=action('start')
        selected=next(v for v in d.phones() if v['id']==owned)
        arguments=dict(phoneId=owned,ownerId=selected['owner_id'],name=name)
        # Only the synthetic transport is slowed down. No host bandwidth or
        # routes are altered and no pre-existing Android file is accessed.
        r['wire']=json.loads(d.run(d.MAIN,['docker','exec','-i',api,'node','--input-type=module','-',json.dumps(arguments)],input=(d.ROOT/'tools/probe_phone_file_progress.mjs').read_bytes(),timeout=330))
        d.need(r['wire']['passed'],'wire_test_failed')
        files=s.request('/api/v1/virtual-phones/'+owned+'/files?generation='+str(selected['generation']))
        d.need(len(files['data'])==202,'member_file_list_truncated');r['memberFileCount']=len(files['data']);r['status']='passed'
    except Exception as e:r['failure']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
    finally:
        credential=None
        if owned:
            try:
                row=s.request('/api/v1/virtual-phones/'+owned)
                if row['runningCharged']:r['stopped']=action('stop')
                r['deleted']=action('delete')
            except Exception as e:r['cleanupError']=str(e);r['status']='failed'
        r['phonesAfter']=d.phones()
        if r['phonesAfter']!=before:r['status']='failed';r['existingPhonesChanged']=True
        if s.csrf:
            try:s.request('/api/auth/sign-out',{})
            except Exception:r['status']='failed'
        r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
        with out.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps({k:r.get(k) for k in ['runId','status','failure','cleanupError']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
