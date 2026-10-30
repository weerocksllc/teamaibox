"""Run GStreamer synthetic regressions in an isolated, device-free Linux container."""
import argparse, datetime as dt, io, json, re, tarfile
import appliance_container_operations as d
from maintenance_build_inputs import container_id, staging_directory, staging_root

def main():
 p=argparse.ArgumentParser();p.add_argument('--run-id',required=True)
 p.add_argument('--staging-root',type=staging_root,required=True)
 p.add_argument('--media-container-id',type=container_id,required=True);a=p.parse_args()
 d.need(re.fullmatch(r'media-cpu-regression-\d{8}-a[1-9]\d*',a.run_id),'invalid_run')
 out=d.ROOT/'evidence/validation/acceptance'/(a.run_id+'.json');d.need(not out.exists(),'occupied')
 live=d.inspect(d.MAIN,a.media_container_id)
 d.need(live['Id']==a.media_container_id and live['State']['Running'],'media_not_running')
 names=['tests/test_trusted_media_audio_signal.py','tests/test_trusted_media_hdmi_timing.py']
 sources=sorted([p for p in (d.ROOT/'services/trusted_media_service').rglob('*.py') if '__pycache__' not in p.parts]+[d.ROOT/n for n in names]+[d.ROOT/'tools/maintenance_build_inputs.py'])
 r=dict(runId=a.run_id,status='failed',startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),image=live['Image'],
  sources={str(p.relative_to(d.ROOT)):d.sha(p.read_bytes()) for p in sources},hardwareAccess=False,appleSenderAccepted=False,
  liveServicesChanged=False,hdmiEnabled=False)
 try:
  stage=staging_directory(a.staging_root,'teamaibox-'+a.run_id);d.run(d.MAIN,['mkdir','-m','0755',stage]);archive=io.BytesIO()
  with tarfile.open(fileobj=archive,mode='w') as t:
   for p in sources:t.add(p,arcname=str(p.relative_to(d.ROOT)),recursive=False)
  d.run(d.MAIN,['tar','-xf','-','-C',stage],input=archive.getvalue())
  code="import unittest,json,sys;sys.path.insert(0,'/validation');s=unittest.TestSuite();l=unittest.defaultTestLoader;[s.addTests(l.discover('/validation/tests',pattern=n)) for n in ['test_trusted_media_audio_signal.py','test_trusted_media_hdmi_timing.py']];r=unittest.TextTestRunner().run(s);print(json.dumps(dict(tests=r.testsRun,failures=len(r.failures),errors=len(r.errors),skipped=len(r.skipped))));sys.exit(not r.wasSuccessful() or bool(r.skipped))"
  raw=d.run(d.MAIN,['docker','run','--rm','--name',a.run_id,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
   '--memory=512m','--memory-swap=512m','--cpus=1','--tmpfs','/tmp:rw,nosuid,size=64m','-e','TEAMAIBOX_REQUIRE_MEDIA_INTEGRATION=1',
   '--mount','type=bind,src='+stage+',dst=/validation,readonly','--entrypoint','/usr/bin/python3',live['Image'],'-c',code],timeout=90)
  r['tests']=json.loads(raw.decode().splitlines()[-1]);d.need(r['tests']==dict(tests=12,failures=0,errors=0,skipped=0),'unexpected_tests')
  after=d.inspect(d.MAIN,live['Id']);d.need(after['State']['StartedAt']==live['State']['StartedAt'] and after['Image']==live['Image'],'live_media_changed')
  r['status']='passed'
 except Exception as e:r['failure']=str(e)
 r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
 with out.open('x') as f:json.dump(r,f,indent=2)
 print(json.dumps({k:r.get(k) for k in ('runId','status','tests','failure')}));return r['status']!='passed'

if __name__=='__main__':raise SystemExit(main())
