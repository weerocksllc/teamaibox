#!/usr/bin/env python3
"""Prepare the exact upstream guest module and a small reviewed source patch."""
import argparse,base64,hashlib,json,subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from phone_camera_guest_driver_patch import COMMIT,adapt

ROOT=Path(__file__).resolve().parents[1]
FILES=('Kbuild','Makefile','protocol.h','scatterlist_filler.c','scatterlist_filler.h',
       'session.h','virtio_media.h','virtio_media_driver.c','virtio_media_ioctls.c')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    stage=args.output.absolute();stage.mkdir(parents=True,exist_ok=False)
    upstream=stage/'upstream';upstream.mkdir();patched=stage/'driver';patched.mkdir()
    def fetch(name):
        url=f'https://android.googlesource.com/platform/external/virtio-media/+/{COMMIT}/driver/{name}?format=TEXT'
        result=subprocess.run(['curl','-fsSL','--connect-timeout','10','--max-time','45',url],capture_output=True)
        if result.returncode:raise RuntimeError('source_download_failed:'+name)
        raw=base64.b64decode(result.stdout,validate=True)
        if not 0<len(raw)<100000:raise RuntimeError('source_size_invalid')
        return name,raw
    with ThreadPoolExecutor(max_workers=3) as pool:files=dict(pool.map(fetch,FILES))
    for name,raw in files.items():
        (upstream/name).write_bytes(raw)
        (patched/name).write_bytes(adapt(raw.decode()).encode() if name=='virtio_media_driver.c' else raw)
    record=dict(commit=COMMIT,upstream={n:hashlib.sha256(v).hexdigest() for n,v in files.items()},
                patchSha256=hashlib.sha256((ROOT/'tools/phone_camera_guest_driver_patch.py').read_bytes()).hexdigest(),
                changedFiles=['virtio_media_driver.c'],compiled=False,deployed=False)
    (stage/'source.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record))

if __name__=='__main__':main()
