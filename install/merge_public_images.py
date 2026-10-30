#!/usr/bin/env python3
"""Merge successful per-role build evidence without inventing missing inputs."""
import argparse
import json
from pathlib import Path
from build_public_services import ALIASES
from offline_common import IMAGE_ROLES, need, read_json, run, write_json

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report',type=Path,action='append',required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    need(not a.output.exists(),'output already exists')
    images={}; evidence={}
    for file in a.report:
        report=read_json(file)
        for role,image in report.get('images',{}).items():
            need(role in IMAGE_ROLES and isinstance(image,str),'not a factory role report: '+str(file))
            need(role not in images or images[role]==image,'conflicting build outputs: '+role)
            actual=json.loads(run(['docker','image','inspect',image]))[0]
            need(actual['Id']==image and actual['Architecture']=='arm64','wrong image identity/architecture')
            images[role]=image; evidence[role]=str(file.absolute())
    for role,parent in ALIASES.items():
        if role not in images and parent in images:
            images[role]=images[parent]; evidence[role]='same public runtime as '+parent
    missing=sorted(IMAGE_ROLES-set(images))
    write_json(a.output,dict(images=images,evidence=evidence,missing=missing,
        completeFactoryImages=not missing,installed=False),0o644)
    print(json.dumps(dict(images=len(images),missing=missing)))
    raise SystemExit(bool(missing))
