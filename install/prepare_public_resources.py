#!/usr/bin/env python3
"""Prepare account-free firmware, Android notices, drivers and source runtime.

Models and host helpers are separate explicit inputs. No live installation,
guest disk, account database or certificate is inspected.
"""
import argparse
import json
from pathlib import Path
import shutil
from build_public_android import acquire
from offline_common import digest, need, read_json, run, write_json

ROOT=Path(__file__).resolve().parents[1]
DRIVER_URL='https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.285-1/virtio-win-0.1.285.iso'
# Microsoft's OpenVMM dependency mirror publishes the identical locked ISO.
# Fedora's browser challenge can otherwise return HTML to build clients.
DRIVER_DOWNLOAD='https://github.com/microsoft/openvmm-deps/releases/download/virtio-iso-v1/virtio-win-0.1.285.iso'
DRIVER_SHA='e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--images',type=Path,required=True)
    p.add_argument('--driver-cache',type=Path,required=True,help='verified clean public virtio driver ISO, never a Windows ISO')
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args(); output=a.output.absolute()
    need(not output.exists(),'choose a new resource directory')
    images=read_json(a.images)['images']
    need({'computer-runtime','phone-runtime','phone-google-runtime'}<=images.keys(),'guest images are incomplete')
    drawing_source=ROOT/'services/drawing-worker/flux2_bf16_protected_server.py'
    need(drawing_source.is_file(),'drawing runtime source is missing')
    output.mkdir(parents=True)
    firmware=output/'computer-firmware';firmware.mkdir()
    run(['docker','run','--rm','--network=none','--read-only','--user','0:0',
        '--mount','type=bind,src='+str(firmware)+',dst=/out','--entrypoint','/bin/sh',images['computer-runtime'],
        '-ec','cp /usr/share/AAVMF/AAVMF_CODE.secboot.fd /out/CODE.fd; '
        'cp /usr/share/AAVMF/AAVMF_VARS.ms.fd /out/VARS.fd; '
        'cp /usr/share/doc/qemu-efi-aarch64/copyright /out/LICENSE; chmod 0444 /out/*'])
    driver=acquire(DRIVER_DOWNLOAD,DRIVER_SHA,a.driver_cache.absolute())
    drivers=output/'computer-drivers';drivers.mkdir()
    shutil.copyfile(driver,drivers/'virtio.iso')
    (drivers/'NOTICE.txt').write_text('Upstream virtio-win drivers: '+DRIVER_URL+'\n'
        'Checksum-identical public mirror: '+DRIVER_DOWNLOAD+'\nSHA-256: '+DRIVER_SHA+'\n'
        'Third-party drivers retain their own licenses; this is not Windows installation media.\n')
    drawing=output/'drawing-runtime';drawing.mkdir()
    shutil.copyfile(drawing_source,drawing/'flux2_bf16_protected_server.py')
    for role,image_role,family in [('android-standard','phone-runtime','standard'),
                                  ('android-google','phone-google-runtime','google-play')]:
        directory=output/role;directory.mkdir()
        write_json(directory/'manifest.json',dict(schemaVersion=1,androidVersion='17',baseBuildId='16102939',
            systemFamily=family,runtimeImageId=images[image_role]),0o644)
        (directory/'NOTICE.txt').write_text('Based on public Android Cuttlefish build 16102939.\n'
            'No user data or account state. APK/APEX signatures and third-party licenses are retained.\n'
            + ('Google compatibility is experimental, not certified; no redistribution grant is implied.\n'
               if family=='google-play' else 'Original Team AI Box runtime code is MIT licensed.\n'))
    assets={path.name:dict(source=str(path),destination='assets/'+path.name)
            for path in output.iterdir() if path.is_dir()}
    write_json(output/'assets.json',assets,0o644)
    print(json.dumps(dict(status='resources-prepared',roles=sorted(assets),privateDataUsed=False)))
