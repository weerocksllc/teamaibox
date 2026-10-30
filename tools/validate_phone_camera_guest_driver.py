#!/usr/bin/env python3
"""Validate an exact offline guest-driver build, not product acceptance."""
import argparse, hashlib, json, re
from pathlib import Path
from build_phone_camera_guest_driver import ROOT, RELEASE, INPUT, COMMIT

sha = lambda raw: hashlib.sha256(raw).hexdigest()

def validate(path):
    path = Path(path).resolve(); r = json.loads(path.read_bytes())
    assert re.fullmatch(r'phone-camera-guest-driver-build-\d{8}-a[1-9]\d*', r['runId'])
    assert path == ROOT/'evidence/validation/virtual-phones'/(r['runId']+'.json')
    assert r['status']=='passed' and r['buildExitCode']==0 and r['containerRemoved']
    assert not r['guestStarted'] and not r['published'] and r['upstreamCommit']==COMMIT
    assert r['kernelInputsSha256']==sha((INPUT/'inputs.json').read_bytes())
    required={'tools/build_phone_camera_guest_driver.py','tools/phone_camera_guest_driver_patch.py',
              'deploy/android/cuttlefish/CameraKernelCompilerOffline.Dockerfile','tools/phone_camera_guest_module_build.sh'}
    assert set(r['sources'])==required
    for name,digest in r['sources'].items(): assert sha((ROOT/name).read_bytes())==digest, name
    module=ROOT/'tmp'/r['runId']/'driver/virtio-media.ko'
    assert ROOT/r['module']==module and not module.is_symlink()
    raw=module.read_bytes()
    assert sha(raw)==r['moduleSha256'] and len(raw)==r['moduleBytes']
    assert raw[:6]==b'\x7fELF\x02\x01' and raw[18:20]==b'\xb7\x00'
    assert b'vermagic='+RELEASE.encode()+b' ' in raw
    compiler=json.loads((ROOT/'tmp/phone-camera-kernel-compiler-input-20260916-a1/inputs.json').read_bytes())
    assert r['compilerImage']==compiler['image']
    return dict(valid=True,runId=r['runId'],sha256=sha(path.read_bytes()),moduleSha256=r['moduleSha256'],module=r['module'])

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',required=True,type=Path)
    print(json.dumps(validate(p.parse_args().evidence)))
