#!/usr/bin/env python3
"""Package only clean, source-built Android runtime inputs, never user data."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import uuid
from build_public_android import acquire
from offline_common import need, read_json, run, write_json

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'deploy/android/cuttlefish'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-image',required=True)
    for arg in ('backend','cache','output'):p.add_argument('--'+arg,type=Path,required=True)
    a=p.parse_args(); output=a.output.absolute()
    need(not output.exists(),'choose a new output directory')
    backend=read_json(a.backend/'build.json')
    need(backend.get('status')=='backend-built','camera backend must have built successfully')
    output.mkdir(parents=True); context=output/'context';context.mkdir()
    for path in SOURCE.glob('phone_*.py'):shutil.copyfile(path,context/path.name)
    for name in ('camera-decoder.lock.json','install_phone_camera_decoder.py'):
        shutil.copyfile(SOURCE/name,context/name)
    shutil.copyfile(ROOT/'services/media_io/resources.py',context/'resources.py')
    shutil.copyfile(ROOT/'tools/inspect_phone_google_compliance.py',context/'inspect_phone_google_compliance.py')
    lock=read_json(SOURCE/'camera-decoder.lock.json')
    shutil.copyfile(acquire(lock['url'],lock['sha256'],a.cache/lock['filename']),context/'camera-decoder.whl')
    shutil.copyfile(backend['backend'],context/'vhu_media_v4l2_stream_proxy')
    host=Path(backend['hostPackage'])/'usr/lib/cuttlefish-common/bin'
    for name in ('crosvm','libgfxstream_backend.so'):shutil.copyfile(host/name,context/name)
    tag='teamaibox-public-phone:'+uuid.uuid4().hex
    with (output/'build.log').open('xb') as log:
        result=subprocess.run(['docker','build','--network=none','--pull=false',
            '--build-arg','PHONE_BASE_IMAGE='+a.base_image,'-f',str(SOURCE/'PublicPhoneRuntime.Dockerfile'),
            '-t',tag,str(context)],stdout=log,stderr=subprocess.STDOUT)
    report=dict(status='failed' if result.returncode else 'runtime-built',deployed=False,privateDataUsed=False,images={},references={})
    if not result.returncode:
        report['images']['phone-runtime']=json.loads(run(['docker','image','inspect',tag]))[0]['Id']
        report['references']['phone-runtime']=tag
    write_json(output/'images.json',report,0o644)
    print(json.dumps(report,indent=2));raise SystemExit(bool(result.returncode))
