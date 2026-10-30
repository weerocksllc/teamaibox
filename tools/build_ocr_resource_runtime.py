"""Offline ARM64 OCR code overlays and CPU tests; never starts a GPU model."""
import argparse,datetime as dt,io,json,re,tarfile
import appliance_container_operations as d
from maintenance_build_inputs import image_id, staging_directory, staging_root

MAPPINGS={'worker':{'services/ocr-worker/managed_dflash_office_server.py':'/opt/teamaibox/ocr-worker/managed_dflash_server.py',
    'services/ocr-worker/managed_dflash_office_engine.py':'/opt/teamaibox/ocr-worker/managed_dflash_engine.py',
    'services/media_io/resources.py':'/opt/teamaibox/ocr-worker/media_resources.py'},
    'provider':{'services/ocr-provider/managed_server.py':'/opt/teamaibox/ocr-provider/managed_server.py',
    'services/media_io/resources.py':'/opt/teamaibox/ocr-provider/media_resources.py'}}
TEST_FILES=['tests/test_ocr_resource_pages.py','services/ocr-provider/test_managed_server.py','services/ocr-worker/managed_dflash_engine.py']

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True)
    p.add_argument('--staging-root',type=staging_root,required=True)
    p.add_argument('--worker-parent-image-id',type=image_id,required=True)
    p.add_argument('--provider-parent-image-id',type=image_id,required=True)
    args=p.parse_args();rid=args.run_id
    parents={'worker':args.worker_parent_image_id,'provider':args.provider_parent_image_id}
    d.need(re.fullmatch(r'ocr-resource-build-\d{8}-a[1-9]\d*',rid),'invalid_run')
    out=d.ROOT/'evidence/validation/supply-chain'/(rid+'.json');d.need(not out.exists(),'run_occupied')
    sources=sorted(set([f for v in MAPPINGS.values() for f in v]+TEST_FILES+['tools/build_ocr_resource_runtime.py','tools/maintenance_build_inputs.py']))
    r=dict(runId=rid,status='failed',startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),sources={f:d.sha((d.ROOT/f).read_bytes()) for f in sources},builds={},modelsStarted=False,liveServicesChanged=False)
    try:
        for kind,mapping in MAPPINGS.items():
            stage=staging_directory(args.staging_root,'teamaibox-'+rid+'-'+kind);d.run(d.MAIN,['test','!','-e',stage]);d.run(d.MAIN,['mkdir','-m','0755',stage])
            archive=io.BytesIO();docker='ARG BASE\nFROM ${BASE}\n'
            with tarfile.open(fileobj=archive,mode='w') as t:
                for f in sources:t.add(d.ROOT/f,arcname=f,recursive=False)
                for f,dest in mapping.items():docker+='COPY --chown=65532:65532 '+f+' '+dest+'\n'
                raw=docker.encode();item=tarfile.TarInfo('Dockerfile');item.size=len(raw);t.addfile(item,io.BytesIO(raw))
            d.run(d.MAIN,['tar','-xf','-','-C',stage],input=archive.getvalue())
            tag='teamaibox/ocr-resources:'+rid+'-'+kind;parent=tag+'-parent'
            d.run(d.MAIN,['docker','tag',parents[kind],parent])
            d.run(d.MAIN,['docker','build','--pull=false','--network=none','--memory=512m','--memory-swap=512m','--build-arg','BASE='+parent,'-t',tag,stage],timeout=120)
            image=json.loads(d.run(d.MAIN,['docker','image','inspect',tag]))[0];base=json.loads(d.run(d.MAIN,['docker','image','inspect',parents[kind]]))[0]
            d.need(image['Architecture']=='arm64' and image['Config']==base['Config'] and image['RootFS']['Layers'][:len(base['RootFS']['Layers'])]==base['RootFS']['Layers'],'parent_changed')
            file=TEST_FILES[0 if kind=='worker' else 1]
            code="import sys,unittest,json,importlib.util;sys.path[:0]=['/validation','/app'];s=importlib.util.spec_from_file_location('resource_tests','/validation/"+file+"');m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);r=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(m));print(json.dumps({'passed':r.wasSuccessful(),'tests':r.testsRun,'skipped':len(r.skipped)}));sys.exit(not r.wasSuccessful() or bool(r.skipped))"
            output=d.run(d.MAIN,['docker','run','--rm','--name',rid+'-'+kind+'-test','--network=none','--read-only','--cpus=2','--memory=512m','--memory-swap=512m','--tmpfs','/tmp:rw,nosuid,size=128m','--mount','type=bind,src='+stage+',dst=/validation,readonly','--entrypoint','/opt/vllm-venv/bin/python' if kind=='worker' else 'python3',image['Id'],'-c',code],timeout=90).decode()
            tests=json.loads(output.strip().splitlines()[-1]);d.need(tests['passed'] and tests['skipped']==0,'tests_failed')
            r['builds'][kind]=dict(parent=parents[kind],image=image['Id'],tests=tests,files=mapping)
            print(json.dumps(dict(phase='built',kind=kind,image=image['Id'],tests=tests)),flush=True)
        d.need(all(d.sha((d.ROOT/f).read_bytes())==h for f,h in r['sources'].items()),'source_changed');r['status']='passed'
    except Exception as e:r['failure']=str(e)
    r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    with out.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps({k:r.get(k) for k in ['runId','status','failure']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
