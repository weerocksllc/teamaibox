"""Run synthetic camera regressions without restarting a phone or using a GPU."""
import argparse,datetime,hashlib,io,json,re,tarfile
from pathlib import Path
from appliance_operations import ROOT,run,need
from appliance_container_operations import MAIN

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);a=p.parse_args()
    need(re.fullmatch(r'phone-resource-inputs-\d{8}-a[1-9]\d*',a.run_id),'invalid_run_id')
    host=MAIN;stage='/var/lib/teamaibox-'+a.run_id
    base='sha256:dbe1d14bdda022c5717b069dfecb2ad9272003b5f3ac8f860d7ac6a9841d0cda'
    output=ROOT/'evidence/validation/virtual-phones'/(a.run_id+'.json')
    need(not output.exists(),'run_id_already_used')
    files=['deploy/android/cuttlefish/'+f for f in ('CameraResourceInputs.Dockerfile','phone_camera_client.py',
        'phone_camera_decode.py','phone_video_camera.py','phone_files.py')]+['services/media_io/resources.py']
    files+=['tools/'+f for f in ('test_phone_camera_decode.py','test_phone_video_control.py',
        'test_phone_video_camera.py','test_phone_resource_inputs_remote.py')]
    files+=['tools/fixtures/phone-camera-checker-v1.jpg']
    report=dict(runId=a.run_id,status='failed',startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        sources={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files},base=base,
        phoneRestarted=False,gpuUsed=False,syntheticOnly=True)
    try:
        run(host,['sudo','-n','test','!','-e',stage]);run(host,['sudo','-n','install','-d','-m','0755',stage])
        archive=io.BytesIO()
        with tarfile.open(fileobj=archive,mode='w') as tar:
            for f in files:tar.add(ROOT/f,arcname=('fixtures/' if '/fixtures/' in f else '')+Path(f).name,recursive=False)
        run(host,['sudo','-n','tar','-xf','-','-C',stage],input=archive.getvalue())
        tag='teamaibox/cuttlefish-inputs:'+a.run_id
        run(host,['env','DOCKER_BUILDKIT=0','docker','build','--network=none','--pull=false',
            '--memory=512m','--memory-swap=512m','--build-arg','BASE='+base,
            '-f',stage+'/CameraResourceInputs.Dockerfile','-t',tag,stage])
        report['image']=json.loads(run(host,['docker','image','inspect',tag]))[0]['Id']
        code="""import sys,unittest,json
sys.path[:0]=['/opt/teamaibox','/opt/teamaibox/camera-python','/validation']
import test_phone_camera_decode as image, test_phone_video_control as control, test_phone_video_camera as video
suite=unittest.TestSuite()
for module in (image,control):suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
missing=('test_audio_track_is_discarded_and_corruption_fails_closed','test_unsupported_video_codec_is_not_auto_selected')
for name in unittest.defaultTestLoader.getTestCaseNames(video.VideoCamera):
 if name not in missing:suite.addTest(video.VideoCamera(name))
suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(video.VideoLifetime))
r=unittest.TextTestRunner(verbosity=2,stream=sys.stdout).run(suite)
print(json.dumps({'passed':r.wasSuccessful(),'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors)}))
"""
        raw=run(host,['docker','run','--rm','--name',a.run_id+'-test','--network=none','--read-only',
            '--memory=1g','--memory-swap=1g','--cpus=2','--tmpfs','/tmp:rw,nosuid,size=256m',
            '--tmpfs','/phone/exchange:rw,nosuid,size=128m',
            '--mount','type=bind,src='+stage+',dst=/validation,readonly','--entrypoint','python3',tag,'-c',code],timeout=150).decode()
        report['testOutput']=raw;report['tests']=json.loads(raw.strip().splitlines()[-1])
        need(report['tests']['passed'],'camera_regression_failed')
        report['status']='passed'
    except Exception as error:report['failure']=str(error)
    report['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    report['limitations']=['Synthetic codecs and framing only, not live Android acceptance.',
        'Two synthetic AAC/MPEG4 encoder cases require encoders absent from the runtime image.']
    with output.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
    print(json.dumps(report));return report['status']!='passed'

if __name__=='__main__':raise SystemExit(main())
