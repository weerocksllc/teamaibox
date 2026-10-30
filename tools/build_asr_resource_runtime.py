"""Build current CPU ASR overlays offline and exercise resource admission."""
import argparse,datetime as dt,io,json,re,tarfile
import appliance_container_operations as d
from maintenance_build_inputs import container_id, staging_directory, staging_root

MAPPING={
 'services/realtime-asr-worker/server.py':'/opt/teamaibox/server.py',
 'services/realtime-asr-worker/media_contract.py':'/opt/teamaibox/media_contract.py',
 'services/media_io/resources.py':'/opt/teamaibox/media_resources.py',
}
TEST='tests/test_asr_resource_inputs.py'

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True)
    p.add_argument('--staging-root',type=staging_root,required=True)
    p.add_argument('--voice-parent-container-id',type=container_id,required=True)
    p.add_argument('--batch-parent-container-id',type=container_id,required=True)
    args=p.parse_args();rid=args.run_id
    containers={'voice':args.voice_parent_container_id,'batch':args.batch_parent_container_id}
    d.need(re.fullmatch(r'asr-resource-build-\d{8}-a[1-9]\d*',rid),'invalid_run')
    out=d.ROOT/'evidence/validation/supply-chain'/(rid+'.json');d.need(not out.exists(),'run_occupied')
    sources=list(MAPPING)+[TEST,'tools/build_asr_resource_runtime.py','tools/maintenance_build_inputs.py']
    r=dict(runId=rid,status='failed',sources={f:d.sha((d.ROOT/f).read_bytes()) for f in sources},startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),builds={},liveServicesChanged=False,modelsStarted=False)
    try:
        for kind,cid in containers.items():
            old=d.inspect(d.MAIN,cid);d.need(old['Id']==cid and old['State']['Running'],'parent_not_running')
            stage=staging_directory(args.staging_root,'teamaibox-'+rid+'-'+kind);d.run(d.MAIN,['test','!','-e',stage]);d.run(d.MAIN,['mkdir','-m','0755',stage])
            archive=io.BytesIO();docker='ARG BASE\nFROM ${BASE}\n'
            with tarfile.open(fileobj=archive,mode='w') as t:
                for f in sources:t.add(d.ROOT/f,arcname=f,recursive=False)
                for f,dest in MAPPING.items():docker+='COPY '+f+' '+dest+'\n'
                raw=docker.encode();item=tarfile.TarInfo('Dockerfile');item.size=len(raw);t.addfile(item,io.BytesIO(raw))
            d.run(d.MAIN,['tar','-xf','-','-C',stage],input=archive.getvalue())
            tag='teamaibox/asr-resources:'+rid+'-'+kind;parent=tag+'-parent';d.run(d.MAIN,['docker','tag',old['Image'],parent])
            d.run(d.MAIN,['docker','build','--pull=false','--network=none','--memory=512m','--memory-swap=512m','--build-arg','BASE='+parent,'-t',tag,stage],timeout=120)
            image=json.loads(d.run(d.MAIN,['docker','image','inspect',tag]))[0];base=json.loads(d.run(d.MAIN,['docker','image','inspect',old['Image']]))[0]
            d.need(image['Architecture']=='arm64' and image['Config']==base['Config'] and image['RootFS']['Layers'][:len(base['RootFS']['Layers'])]==base['RootFS']['Layers'],'parent_changed')
            code="import importlib.util,sys,unittest,json;s=importlib.util.spec_from_file_location('resource_tests','/validation/"+TEST+"');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(m));print(json.dumps({'passed':r.wasSuccessful(),'tests':r.testsRun,'skipped':len(r.skipped)}));sys.exit(not r.wasSuccessful() or bool(r.skipped))"
            output=d.run(d.MAIN,['docker','run','--rm','--name',rid+'-'+kind+'-test','--network=none','--read-only','--cpus=2','--memory=768m','--memory-swap=768m','--tmpfs','/tmp:rw,nosuid,size=128m','--mount','type=bind,src='+stage+',dst=/validation,readonly','--env','ASR_MAX_UPLOAD_BYTES=','--entrypoint','python3',image['Id'],'-c',code],timeout=120)
            result=json.loads(output.decode().strip().splitlines()[-1]);d.need(result['passed'] and result['skipped']==0,'tests_failed')
            d.need(d.inspect(d.MAIN,cid)['State']['Running'],'live_parent_stopped')
            r['builds'][kind]=dict(parent=old['Image'],container=cid,image=image['Id'],tests=result,files=MAPPING)
            print(json.dumps(dict(phase='built',kind=kind,image=image['Id'],tests=result)),flush=True)
        d.need(all(d.sha((d.ROOT/f).read_bytes())==v for f,v in r['sources'].items()),'source_changed');r['status']='passed'
    except Exception as e:r['failure']=str(e)
    r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    with out.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps({k:r.get(k) for k in ['runId','status','failure']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
