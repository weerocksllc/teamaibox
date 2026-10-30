"""Test main-box FLUX code in its real image without loading another model."""
import argparse
import datetime as dt
import io
import json
import re
import tarfile
import appliance_container_operations as d
from maintenance_build_inputs import image_id, staging_directory, staging_root

SOURCES=['services/drawing-worker/flux2_bf16_protected_server.py',
    'services/drawing-worker/flux2_comfy_server.py','services/drawing-worker/server.py',
    'services/drawing-worker/specialist_server.py','services/media_io/resources.py',
    'tests/test_drawing_resource_admission.py','tools/build_flux_protected_resource_bundle.py','tools/maintenance_build_inputs.py']

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True)
    p.add_argument('--staging-root',type=staging_root,required=True)
    p.add_argument('--image-id',type=image_id,required=True);a=p.parse_args()
    d.need(re.fullmatch(r'flux-protected-resource-build-\d{8}-a[1-9]\d*',a.run_id),'invalid_run')
    out=d.ROOT/'evidence/validation/supply-chain'/(a.run_id+'.json')
    d.need(not out.exists(),'occupied')
    r=dict(runId=a.run_id,status='failed',image=a.image_id,modelsStarted=False,liveServicesChanged=False,
        startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),sources={s:d.sha((d.ROOT/s).read_bytes()) for s in SOURCES})
    try:
        stage=staging_directory(a.staging_root,'teamaibox-'+a.run_id)
        d.run(d.MAIN,['test','!','-e',stage]);d.run(d.MAIN,['mkdir','-m','0755',stage])
        archive=io.BytesIO()
        with tarfile.open(fileobj=archive,mode='w') as t:
            for s in SOURCES:t.add(d.ROOT/s,arcname=s,recursive=False)
        d.run(d.MAIN,['tar','-xf','-','-C',stage],input=archive.getvalue())
        code="import sys,unittest,json;sys.path[:0]=['/validation','/validation/tests'];import test_drawing_resource_admission as t;r=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(t));print(json.dumps({'passed':r.wasSuccessful(),'tests':r.testsRun,'skipped':len(r.skipped)}));sys.exit(not r.wasSuccessful() or bool(r.skipped))"
        raw=d.run(d.MAIN,['docker','run','--rm','--name',a.run_id+'-test','--network=none','--read-only',
            '--cpus=2','--memory=1536m','--memory-swap=1536m','--tmpfs','/tmp:rw,nosuid,size=256m',
            '--mount','type=bind,src='+stage+',dst=/validation,readonly','--entrypoint','python3',a.image_id,'-c',code],timeout=90)
        r['tests']=json.loads(raw.decode().strip().splitlines()[-1])
        d.need(r['tests']['passed'] and r['tests']['tests']==5 and not r['tests']['skipped'],'tests_failed')
        d.need(all(d.sha((d.ROOT/s).read_bytes())==h for s,h in r['sources'].items()),'source_changed')
        r['status']='passed'
    except Exception as e:r['failure']=str(e)
    r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    with out.open('x') as f:json.dump(r,f,indent=2)
    print(json.dumps(r));return r['status']!='passed'

if __name__=='__main__':raise SystemExit(main())
