"""Exercise a new CPU-only ASR container without stopping existing services."""
import argparse,datetime as dt,json,re,time
import appliance_container_operations as d

PARENT='evidence/validation/supply-chain/asr-resource-build-20260915-a1.json'
def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);rid=p.parse_args().run_id
    d.need(re.fullmatch(r'asr-resource-protocol-\d{8}-a[1-9]\d*',rid),'invalid_run')
    out=d.ROOT/'evidence/validation/model-smoke'/(rid+'.json');d.need(not out.exists(),'run_occupied')
    parent=json.loads((d.ROOT/PARENT).read_bytes());d.need(parent['status']=='passed','parent_failed')
    image=parent['builds']['batch']['image'];name='teamaibox-'+rid;cid=None
    files=['tools/test_asr_resource_protocol.py','tools/probe_asr_large_upload.py']
    r=dict(runId=rid,status='failed',image=image,parentEvidence=PARENT,parentSha256=d.sha((d.ROOT/PARENT).read_bytes()),sources={f:d.sha((d.ROOT/f).read_bytes()) for f in files},startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),liveServicesChanged=False)
    try:
        d.run(d.MAIN,['docker','image','inspect',image])
        cid=d.run(d.MAIN,['docker','run','-d','--name',name,'--network=none','--read-only','--cpus=2','--memory=2g','--memory-swap=2g','--tmpfs','/tmp:rw,nosuid,size=256m','--env','ASR_MAX_UPLOAD_BYTES=','--env','ASR_CPU_THREADS=2','--label','org.teamaibox.run='+rid,image]).decode().strip()
        r['container']=cid;d.wait(lambda:d.healthy(d.MAIN,cid),120)
        raw=d.run(d.MAIN,['docker','exec','-i',cid,'python3','-'],input=(d.ROOT/files[1]).read_bytes(),timeout=180)
        r['protocol']=json.loads(raw);d.need(r['protocol']['passed'] and r['protocol']['cleanup'],'protocol_failed')
        c=d.inspect(d.MAIN,cid);d.need(not c['State']['OOMKilled'] and d.healthy(d.MAIN,cid),'worker_failed')
        r['status']='passed'
    except Exception as e:r['failure']=str(e)
    finally:
        if cid:
            c=d.inspect(d.MAIN,cid);d.need(c['Name']=='/'+name and c['Image']==image and c['Config']['Labels'].get('org.teamaibox.run')==rid,'cleanup_identity_changed')
            d.run(d.MAIN,['docker','stop','--time','10',cid]);d.run(d.MAIN,['docker','rm',cid]);r['cleanup']=True
    r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    with out.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps({k:r.get(k) for k in ['runId','status','failure','protocol','cleanup']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
