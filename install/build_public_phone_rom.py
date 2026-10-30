#!/usr/bin/env python3
"""Apply source-built camera APK and module to a pristine AOSP image.

Explicit build directories only. Never mounts a running phone or guest disk.
The output remains a build image; runtime assembly is a separate step.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from offline_common import digest, need, read_json, run, write_json

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'deploy/android/cuttlefish'

def build(base, tools, apk, module, output):
    need(not output.exists(), 'choose a new build directory')
    apk_report=read_json(apk/'camera-preview.json'); module_report=read_json(module/'build.json')
    need(apk_report.get('status')=='built' and digest(apk/'Camera2.apk')==apk_report.get('apkSha256'), 'camera APK build mismatch')
    need(module_report.get('status')=='passed' and digest(module/'driver/virtio-media.ko')==module_report.get('moduleSha256'), 'guest driver build mismatch')
    output.mkdir(parents=True)
    prefix='teamaibox-public-rom:'+uuid.uuid4().hex
    report=dict(status='building',deployed=False,privateDataUsed=False,images={})
    def execute(name, command):
        with (output/(name+'.log')).open('xb') as log:
            result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
        need(result.returncode==0,'failed '+name+'; see '+name+'.log')
    def operation(name, image, script, mounts):
        command=['docker','run','--rm','--network=none','--read-only','--user','0:0',
                 '--env','PHONE_ROM_BASE=/opt/cuttlefish',
                 '--tmpfs','/tmp:size=2g','--entrypoint','python3',
                 '--mount','type=bind,src='+str(SOURCE)+',dst=/build,readonly']
        for source,target,readonly in mounts:
            command+=['--mount','type=bind,src='+str(source)+',dst='+target+(',readonly' if readonly else '')]
        execute(name,[*command,image,'/build/'+script])
    def image(name,parent,recipe,context):
        tag=prefix+'-'+name
        execute(name,['docker','build','--network=none','--pull=false','--build-arg','PHONE_BASE_IMAGE='+parent,
                      '-f',str(SOURCE/recipe),'-t',tag,str(context)])
        report['images'][name]=dict(reference=tag,imageId=json.loads(run(['docker','image','inspect',tag]))[0]['Id'])
        return tag
    try:
        extraction=output/'extraction'; extraction.mkdir()
        operation('extract',tools,'prepare_camera_rom_inputs.py',[(extraction,'/work',False)])
        inputs=output/'inputs'
        shutil.copytree(extraction/'inputs',inputs)
        for name in ('Camera2.apk','camera-preview.json'):shutil.copyfile(apk/name,inputs/name)
        shutil.copyfile(module/'driver/virtio-media.ko',inputs/'virtio-media.ko')
        write_json(inputs/'driver.json',module_report,0o644)
        preview=output/'preview'; preview.mkdir()
        operation('preview',tools,'camera_preview_rom.py',[(preview,'/work',False),(inputs,'/inputs',True)])
        preview_image=image('preview-image',tools,'PreviewPartitions.Dockerfile',preview/'images')
        driver=output/'driver'; driver.mkdir()
        operation('driver',preview_image,'camera_driver_rom.py',[(driver,'/work',False),(inputs,'/inputs',True)])
        # EROFS assembly runs as root. Return only the new output directory to
        # its build owner so the host can add the sibling vbmeta file.
        execute('output-owner',['docker','run','--rm','--network=none','--user','0:0',
            '--entrypoint','chown','--mount','type=bind,src='+str(driver)+',dst=/work',
            tools,str(os.getuid())+':'+str(os.getgid()),'/work/images'])
        shutil.copyfile(preview/'images/vbmeta_system.img',driver/'images/vbmeta_system.img')
        final=image('camera-partitions',base,'DriverPartitions.Dockerfile',driver/'images')
        report.update(status='camera-partitions-built',reference=final,
            apkSha256=apk_report['apkSha256'],moduleSha256=module_report['moduleSha256'])
    except Exception as error:report.update(status='failed',failure=str(error))
    write_json(output/'build.json',report,0o644)
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-image',required=True);p.add_argument('--tools-image',required=True)
    for arg in ('apk','module','output'):p.add_argument('--'+arg,type=Path,required=True)
    a=p.parse_args(); result=build(a.base_image,a.tools_image,a.apk.resolve(),a.module.resolve(),a.output.absolute())
    print(json.dumps(result,indent=2));raise SystemExit(result['status']=='failed')
