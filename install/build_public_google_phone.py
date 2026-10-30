#!/usr/bin/env python3
"""Assemble inspected Google components over source-built, account-free Android.

Not a certification or redistribution grant. Never takes a guest data disk.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from offline_common import digest, need, read_json, run, write_json

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'deploy/android/cuttlefish'

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-image', required=True)
    p.add_argument('--tools-image', required=True)
    p.add_argument('--inspection', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--resume-assembly', action='store_true', help='reuse a completed, rehashed assembly after packaging failed')
    a = p.parse_args()
    output = a.output.absolute()
    need(not output.exists() or a.resume_assembly, 'choose a new output directory')
    inspected = read_json(a.inspection / 'inspection.json')
    need(inspected.get('allSelectedComponentSignaturesVerified'), 'unverified Google input')
    output.mkdir(parents=True, exist_ok=a.resume_assembly)
    assembly = output / 'assembly'; assembly.mkdir(exist_ok=a.resume_assembly)
    report = dict(status='building', privateDataUsed=False, deployed=False, images={}, references={}, resumedAssembly=a.resume_assembly)
    try:
        if a.resume_assembly:
            prior = read_json(output/'images.json')
            need(prior['status']=='failed', 'only a failed packaging run may resume')
            write_json(output/('prior-failure-'+uuid.uuid4().hex+'.json'),prior,0o644)
        else:
            with (output / 'assembly.log').open('xb') as log:
                subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only',
                    '--user', '0:0', '--tmpfs', '/tmp:size=2g', '--entrypoint', 'python3',
                    '--mount', 'type=bind,src='+str(SOURCE)+',dst=/build,readonly',
                    '--mount', 'type=bind,src='+str(a.inspection.absolute())+',dst=/source,readonly',
                    '--mount', 'type=bind,src='+str(assembly)+',dst=/work',
                    a.tools_image, '/build/gapps_assemble.py'], check=True, stdout=log, stderr=subprocess.STDOUT)
        result = read_json(assembly / 'assembly.json')
        context = assembly / 'images'
        need(set(result['outputs'])=={'super.img','vbmeta_system.img'}, 'unexpected assembly outputs')
        for name, expected in result['outputs'].items():
            need(digest(context/name)==expected, 'assembled partition changed')
        expected_base = run(['docker','run','--rm','--network=none','--read-only','--entrypoint',
            'sha256sum',a.base_image,'/opt/cuttlefish/super.img']).split()[0]
        need(expected_base==result['baseSuperSha256'], 'assembly does not match the requested base')
        run(['docker','run','--rm','--network=none','--user','0:0','--entrypoint','chown',
             '--mount','type=bind,src='+str(assembly)+',dst=/work',a.tools_image,
             str(os.getuid())+':'+str(os.getgid()),'/work/images'])
        write_json(context / 'google-play-experiment.json', dict(schemaVersion=1,
            androidVersion='17', baseBuildId='16102939', experimental=True,
            certified=False, googleLoginTested=False, redistributionApproved=False,
            source=read_json(SOURCE/'gapps.inputs.lock.json'),
            baseSuperSha256=result['baseSuperSha256'], outputs=result['outputs']), 0o444)
        tag = 'teamaibox-public-google:' + uuid.uuid4().hex
        with (output / 'build.log').open('xb') as log:
            subprocess.run(['docker', 'build', '--network=none', '--pull=false',
                '--build-arg', 'PHONE_BASE_IMAGE='+a.base_image, '-f',
                str(SOURCE/'GoogleCameraProduct.Dockerfile'), '-t', tag, str(context)],
                check=True, stdout=log, stderr=subprocess.STDOUT)
        report['images']['phone-google-runtime'] = json.loads(run(['docker','image','inspect',tag]))[0]['Id']
        report['references']['phone-google-runtime'] = tag
        report['status'] = 'runtime-built'
    except Exception:
        report['status'] = 'failed'
        raise
    finally:
        write_json(output/'images.json', report, 0o644)
    print(json.dumps(report, indent=2))
